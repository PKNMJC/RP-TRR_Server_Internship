import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LineOAService } from './line-oa.service';
import * as line from '@line/bot-sdk';

export interface LineNotificationPayload {
  type: string;
  title: string;
  message: string;
  actionUrl?: string;
  richMessage?: any;
}

export interface RepairTicketNotificationPayload {
  ticketCode: string;
  reporterName: string;
  department: string;
  problemTitle: string;
  location: string;
  urgency: string;
  createdAt: string;
}

@Injectable()
export class LineOANotificationService {
  private readonly logger = new Logger(LineOANotificationService.name);
  private readonly channelAccessToken = process.env.LINE_ACCESS_TOKEN || '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineOAService: LineOAService,
  ) {}

  /**
   * ส่งการแจ้งเตือนไปยัง LINE
   */
  async sendNotification(userId: number, payload: LineNotificationPayload) {
    try {
      // หาการเชื่อมต่อ LINE ของผู้ใช้
      const lineLink = await this.prisma.lineOALink.findUnique({
        where: { userId },
      });

      // ถ้าไม่ได้เชื่อมต่อ LINE ก็ข้ามไป
      if (!lineLink || lineLink.status !== 'VERIFIED') {
        this.logger.warn(
          `User ${userId} is not linked to LINE, skipping notification`,
        );
        return {
          success: false,
          reason: 'User not linked to LINE',
        };
      }

      // Check if lineUserId exists
      if (!lineLink.lineUserId) {
        return {
          success: false,
          error: 'User has not linked their LINE account yet',
        };
      }

      // สร้างข้อความให้ LINE
      const message = this.createMessage(payload);

      // ส่งข้อความไปยัง LINE
      await this.lineOAService.sendMessage(lineLink.lineUserId, message);

      // บันทึกใน database
      await this.prisma.lineNotification.create({
        data: {
          lineUserId: lineLink.lineUserId,
          type: payload.type,
          title: payload.title,
          message: payload.message,
          status: 'SENT',
        },
      });

      this.logger.log(
        `Notification sent to user ${userId} via LINE (${lineLink.lineUserId})`,
      );

      return {
        success: true,
        message: 'Notification sent successfully',
      };
    } catch (error) {
      this.logger.error(`Failed to send notification to user ${userId}:`, error);

      // บันทึก error
      try {
        const lineLink = await this.prisma.lineOALink.findUnique({
          where: { userId },
        });
        if (lineLink && lineLink.lineUserId) {
          await this.prisma.lineNotification.create({
            data: {
              lineUserId: lineLink.lineUserId,
              type: payload.type,
              title: payload.title,
              message: payload.message,
              status: 'FAILED',
              errorMessage: error.message,
            },
          });
        }
      } catch (dbError) {
        this.logger.error('Failed to log notification error:', dbError);
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * ส่งการแจ้งเตือนไปยังหลายผู้ใช้
   */
  async sendBulkNotification(
    userIds: number[],
    payload: LineNotificationPayload,
  ) {
    const results: Array<{
      userId: number;
      success: boolean;
      reason?: string;
      message?: string;
      error?: string;
    }> = [];

    for (const userId of userIds) {
      const result = await this.sendNotification(userId, payload);
      results.push({
        userId,
        ...(result as any),
      });
    }

    return {
      total: userIds.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  }

  /**
   * สร้างข้อความสำหรับ LINE
   */
  private createMessage(payload: LineNotificationPayload): any {
    // ถ้ามี rich message ให้ใช้ นั่นแล้ว
    if (payload.richMessage) {
      return payload.richMessage;
    }

    // สร้าง text message
    let messageText = `📬 ${payload.title}\n\n${payload.message}`;

    if (payload.actionUrl) {
      messageText += `\n\n👉 ดูรายละเอียด: ${payload.actionUrl}`;
    }

    return {
      type: 'text',
      text: messageText,
    };
  }

  /**
   * สร้าง Flex Message สำหรับการแจ้งเตือนงาน
   */
  createTicketMessage(ticketData: {
    code: string;
    title: string;
    description: string;
    priority: string;
    actionUrl: string;
  }) {
    const priorityEmoji = {
      LOW: '🟢',
      MEDIUM: '🟡',
      HIGH: '🔴',
    };

    return {
      type: 'flex',
      altText: `งาน ${ticketData.code}: ${ticketData.title}`,
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '📋 มีงานใหม่',
              weight: 'bold',
              size: 'xl',
              color: '#000000',
            },
          ],
          backgroundColor: '#f0f0f0',
          paddingAll: 'md',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              contents: [
                {
                  type: 'text',
                  text: 'รหัส:',
                  color: '#aaaaaa',
                  size: 'sm',
                  flex: 2,
                },
                {
                  type: 'text',
                  text: ticketData.code,
                  wrap: true,
                  color: '#666666',
                  size: 'sm',
                  flex: 3,
                },
              ],
            },
            {
              type: 'box',
              layout: 'baseline',
              contents: [
                {
                  type: 'text',
                  text: 'หัวข้อ:',
                  color: '#aaaaaa',
                  size: 'sm',
                  flex: 2,
                },
                {
                  type: 'text',
                  text: ticketData.title,
                  wrap: true,
                  color: '#666666',
                  size: 'sm',
                  flex: 3,
                },
              ],
            },
            {
              type: 'box',
              layout: 'baseline',
              contents: [
                {
                  type: 'text',
                  text: 'ความสำคัญ:',
                  color: '#aaaaaa',
                  size: 'sm',
                  flex: 2,
                },
                {
                  type: 'text',
                  text: `${priorityEmoji[ticketData.priority]} ${ticketData.priority}`,
                  color: '#666666',
                  size: 'sm',
                  flex: 3,
                },
              ],
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: {
                type: 'uri',
                label: 'ดูรายละเอียด',
                uri: ticketData.actionUrl,
              },
            },
          ],
          flex: 0,
        },
      },
    };
  }

  /**
   * Retry การส่งที่ล้มเหลว
   */
  async retryFailedNotifications() {
    const failedNotifications = await this.prisma.lineNotification.findMany({
      where: {
        status: 'FAILED',
        retryCount: {
          lt: 3, // ลองใหม่แค่ 3 ครั้ง
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 10, // ลองใหม่ 10 รายการ ต่อครั้ง
    });

    for (const notification of failedNotifications) {
      try {
        // ลองส่งใหม่
        await this.lineOAService.sendMessage(notification.lineUserId, {
          type: 'text',
          text: notification.message,
        });

        // อัปเดตสถานะ
        await this.prisma.lineNotification.update({
          where: { id: notification.id },
          data: {
            status: 'SENT',
            retryCount: notification.retryCount + 1,
          },
        });

        this.logger.log(
          `Retry notification ${notification.id} succeeded`,
        );
      } catch (error) {
        // อัปเดต retry count
        await this.prisma.lineNotification.update({
          where: { id: notification.id },
          data: {
            retryCount: notification.retryCount + 1,
            errorMessage: error.message,
          },
        });

        this.logger.error(
          `Retry notification ${notification.id} failed:`,
          error,
        );
      }
    }

    return {
      processed: failedNotifications.length,
    };
  }

  /**
   * ส่งการแจ้งเตือน Repair Ticket ไปยัง IT Team
   */
  async notifyRepairTicketToITTeam(payload: RepairTicketNotificationPayload) {
    try {
      const client = new line.Client({
        channelAccessToken: this.channelAccessToken,
      });

      // ค้นหา IT team users ทั้งหมด
      const itUsers = await this.prisma.user.findMany({
        where: {
          role: 'IT',
        },
        include: {
          lineOALink: true,
        },
      });

      const itLineUserIds = itUsers
        .filter(u => u.lineOALink && u.lineOALink.status === 'VERIFIED' && u.lineOALink.lineUserId)
        .map(u => u.lineOALink!.lineUserId as string);

      if (itLineUserIds.length === 0) {
        this.logger.warn('No IT users linked to LINE');
        return {
          success: false,
          reason: 'No IT users linked to LINE',
        };
      }

      // สร้าง message สำหรับ IT team
      const urgencyEmoji = {
        NORMAL: '🟢',
        URGENT: '🟡',
        CRITICAL: '🔴',
      };

      const message: line.Message = {
        type: 'template',
        altText: `มีรายการแจ้งซ่อมใหม่: ${payload.ticketCode}`,
        template: {
          type: 'buttons',
          text: `🔔 มีรายการแจ้งซ่อมใหม่\n\n` +
                `เลขที่: ${payload.ticketCode}\n` +
                `${urgencyEmoji[payload.urgency]} ความเร่งด่วน: ${payload.urgency}\n` +
                `👤 ผู้แจ้ง: ${payload.reporterName}\n` +
                `部: ${payload.department || 'ไม่ระบุ'}\n` +
                `🔧 ปัญหา: ${payload.problemTitle}\n` +
                `📍 สถานที่: ${payload.location}\n` +
                `🕐 เวลา: ${payload.createdAt}`,
          actions: [
            {
              type: 'uri',
              label: 'ดูรายละเอียด',
              uri: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/repairs?id=${payload.ticketCode}`,
            },
          ],
        },
      };

      // ส่ง notification ไปยัง IT team
      const results: Array<{ lineUserId: string; success: boolean; error?: any }> = [];
      for (const lineUserId of itLineUserIds) {
        try {
          await client.pushMessage(lineUserId, message);
          
          // บันทึก notification ลง database
          await this.prisma.lineNotification.create({
            data: {
              lineUserId,
              type: 'REPAIR_TICKET_CREATED',
              title: `มีรายการแจ้งซ่อมใหม่: ${payload.ticketCode}`,
              message: payload.problemTitle,
              status: 'SENT',
            },
          });

          results.push({ lineUserId, success: true });
        } catch (error) {
          this.logger.error(`Failed to notify ${lineUserId}:`, error);
          results.push({ lineUserId, success: false, error: error.message });
        }
      }

      return {
        success: true,
        totalRecipients: itLineUserIds.length,
        successful: results.filter(r => r.success).length,
        results,
      };
    } catch (error) {
      this.logger.error('Failed to notify IT team:',error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * ส่งการแจ้งเตือน Repair Ticket Status Update ไปยังผู้แจ้ง
   */
  async notifyRepairTicketStatusUpdate(
    userId: number,
    ticketCode: string,
    status: string,
    message: string,
  ) {
    try {
      const lineLink = await this.prisma.lineOALink.findUnique({
        where: { userId },
      });

      if (!lineLink || lineLink.status !== 'VERIFIED' || !lineLink.lineUserId) {
        return {
          success: false,
          reason: 'User not linked to LINE',
        };
      }

      const client = new line.Client({
        channelAccessToken: this.channelAccessToken,
      });

      const statusEmoji = {
        PENDING: '⏳',
        IN_PROGRESS: '🟡',
        WAITING_PARTS: '🔵',
        COMPLETED: '✅',
        CANCELLED: '❌',
      };

      const notificationMessage: line.Message = {
        type: 'text',
        text: `${statusEmoji[status]} รายการแจ้งซ่อม ${ticketCode}\n` +
              `สถานะ: ${status}\n\n` +
              `${message}\n\n` +
              `กดดูสถานะปัจจุบันจากเมนูด้านล่าง`,
      };

      await client.pushMessage(lineLink.lineUserId, notificationMessage);

      // บันทึก notification
      await this.prisma.lineNotification.create({
        data: {
          lineUserId: lineLink.lineUserId,
          type: 'REPAIR_TICKET_STATUS_UPDATED',
          title: `สถานะ ${ticketCode} เปลี่ยนแปลง`,
          message,
          status: 'SENT',
        },
      });

      return {
        success: true,
      };
    } catch (error) {
      this.logger.error(`Failed to notify status update to user ${userId}:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
