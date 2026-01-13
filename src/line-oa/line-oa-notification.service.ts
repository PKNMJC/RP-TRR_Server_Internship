import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LineOAService } from './line-oa.service';
import { LineNotificationStatus } from '@prisma/client';
import * as line from '@line/bot-sdk';

// --- Types & Constants ---

const COLORS = {
  CRITICAL: '#D32F2F',
  URGENT: '#F57C00',
  NORMAL: '#2E7D32',
  SUCCESS: '#2ECC71',
  INFO: '#3498DB',
  WARNING: '#F39C12',
  SECONDARY: '#95A5A6',
  PRIMARY: '#34495E',
};

// --- Interfaces ---
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineOAService: LineOAService,
  ) {}

  /**
   * Main Method: ส่งการแจ้งเตือนทั่วไป
   */
  async sendNotification(userId: number, payload: LineNotificationPayload) {
    try {
      const lineLink = await this.getVerifiedLineLink(userId);
      if (!lineLink) return { success: false, reason: 'User not linked to LINE' };

      const message = payload.richMessage || this.createDefaultTextMessage(payload);
      
      await this.lineOAService.sendMessage(lineLink.lineUserId!, message);
      await this.saveNotificationLog(lineLink.lineUserId!, payload, LineNotificationStatus.SENT);

      return { success: true, message: 'Notification sent' };
    } catch (error) {
      this.logger.error(`Failed to send notification to user ${userId}: ${error.message}`);
      await this.logFailure(userId, payload, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * ส่งการแจ้งเตือน Repair Ticket ใหม่ไปยังทีม IT (Broadcast/Bulk)
   */
  async notifyRepairTicketToITTeam(payload: RepairTicketNotificationPayload) {
    try {
      const itUsers = await this.prisma.user.findMany({
        where: { role: 'IT', lineOALink: { status: 'VERIFIED' } },
        include: { lineOALink: true },
      });

      const itLineUserIds = itUsers.map(u => u.lineOALink?.lineUserId).filter((id): id is string => id !== null && id !== undefined);

      if (itLineUserIds.length === 0) {
        this.logger.warn('No IT users with verified LINE links found');
        return { success: false, reason: 'No verified IT users' };
      }

      const flexMessage: any = {
        type: 'flex',
        altText: `📢 งานซ่อมใหม่: ${payload.ticketCode}`,
        contents: this.createRepairTicketFlex(payload),
      };

      // ส่งแบบ Multicast (ประหยัด API Rate Limit กว่าวนลูปส่งทีละคน)
      await this.lineOAService.sendMulticast(itLineUserIds, flexMessage);

      // บันทึก log สำหรับทุกคน
      const logPromises = itLineUserIds.map(lineId => 
        this.saveNotificationLog(lineId, {
          type: 'REPAIR_TICKET_CREATED',
          title: `งานใหม่: ${payload.ticketCode}`,
          message: payload.problemTitle
        }, LineNotificationStatus.SENT)
      );
      await Promise.all(logPromises);

      return { success: true, count: itLineUserIds.length };
    } catch (error) {
      this.logger.error('IT Team notification failed', error.stack);
      return { success: false, error: error.message };
    }
  }

  /**
   * แจ้งเตือนอัปเดตสถานะงานซ่อมให้ผู้แจ้ง
   */
  async notifyRepairTicketStatusUpdate(userId: number, ticketCode: string, status: string, remark: string) {
    const lineLink = await this.getVerifiedLineLink(userId);
    if (!lineLink) return { success: false };

    const flexMessage: any = {
      type: 'flex',
      altText: `🔄 อัปเดตสถานะ ${ticketCode}`,
      contents: this.createStatusUpdateFlex(ticketCode, status, remark),
    };

    try {
      await this.lineOAService.sendMessage(lineLink.lineUserId!, flexMessage);
      await this.saveNotificationLog(lineLink.lineUserId!, {
        type: 'REPAIR_STATUS_UPDATE',
        title: `อัปเดตงาน ${ticketCode}`,
        message: remark
      }, LineNotificationStatus.SENT);
      return { success: true };
    } catch (error) {
      this.logger.error(`Status update notification failed: ${error.message}`);
      return { success: false };
    }
  }

  // --- Private Helpers (The "Clean" Part) ---

  private async getVerifiedLineLink(userId: number) {
    const link = await this.prisma.lineOALink.findUnique({ where: { userId } });
    if (!link || link.status !== 'VERIFIED' || !link.lineUserId) {
      this.logger.warn(`User ${userId} has no verified LINE connection`);
      return null;
    }
    return link;
  }

  private async saveNotificationLog(lineUserId: string, payload: Partial<LineNotificationPayload>, status: LineNotificationStatus, error?: string) {
    return this.prisma.lineNotification.create({
      data: {
        lineUserId,
        type: payload.type ?? '',
        title: payload.title ?? '',
        message: payload.message ?? '',
        status,
        errorMessage: error,
      },
    });
  }

  private async logFailure(userId: number, payload: LineNotificationPayload, error: string) {
    const link = await this.prisma.lineOALink.findUnique({ where: { userId } });
    if (link?.lineUserId) {
      await this.saveNotificationLog(link.lineUserId, payload, LineNotificationStatus.FAILED, error);
    }
  }

  private createDefaultTextMessage(payload: LineNotificationPayload) {
    const text = `📬 ${payload.title}\n\n${payload.message}${payload.actionUrl ? `\n\n👉 รายละเอียด: ${payload.actionUrl}` : ''}`;
    return { type: 'text', text };
  }

  // --- Flex Message Factories ---

  private createRepairTicketFlex(payload: RepairTicketNotificationPayload) {
    const urgencyColor = this.getUrgencyConfig(payload.urgency).color;
    const detailUrl = `${process.env.FRONTEND_URL}/admin/repairs?id=${payload.ticketCode}`;

    return {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: urgencyColor,
        contents: [
          { type: 'text', text: '📝 แจ้งซ่อมใหม่', weight: 'bold', color: '#FFFFFF', size: 'lg' },
          { type: 'text', text: `ความสำคัญ: ${this.getUrgencyConfig(payload.urgency).text}`, color: '#FFFFFF', size: 'xs', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: payload.ticketCode, weight: 'bold', size: 'xl', align: 'center' },
          { type: 'separator' },
          this.createFlexRow('ผู้แจ้ง', payload.reporterName),
          this.createFlexRow('สถานที่', payload.location),
          this.createFlexRow('ปัญหา', payload.problemTitle, true),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', style: 'primary', color: urgencyColor, action: { type: 'uri', label: 'รับงานซ่อม', uri: detailUrl } },
        ],
      },
    };
  }

  private createStatusUpdateFlex(code: string, status: string, remark: string) {
    const config = this.getStatusConfig(status);
    const trackingUrl = `https://liff.line.me/${process.env.LINE_LIFF_ID}?id=${code}`;

    return {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: config.color,
        contents: [{ type: 'text', text: '🔄 อัปเดตสถานะงาน', color: '#FFFFFF', weight: 'bold' }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: code, size: 'xs', color: '#AAAAAA' },
          { type: 'text', text: config.text, weight: 'bold', size: 'xxl', color: config.color, align: 'center' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: 'หมายเหตุจากเจ้าหน้าที่:', size: 'xs', color: '#AAAAAA', margin: 'md' },
          { type: 'text', text: remark || '-', wrap: true, size: 'sm' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'button', style: 'secondary', action: { type: 'uri', label: 'ตรวจสอบสถานะ', uri: trackingUrl } }],
      },
    };
  }

  private createFlexRow(label: string, value: string, isBold = false) {
    return {
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: label, color: '#aaaaaa', size: 'sm', flex: 2 },
        { type: 'text', text: value, wrap: true, color: '#666666', size: 'sm', flex: 5, weight: isBold ? 'bold' : 'regular' },
      ],
    };
  }

  // --- Mappings ---

  private getUrgencyConfig(urgency: string) {
    const maps = {
      CRITICAL: { color: COLORS.CRITICAL, text: 'ด่วนที่สุด 🚨' },
      URGENT: { color: COLORS.URGENT, text: 'ด่วน ⚠️' },
      NORMAL: { color: COLORS.NORMAL, text: 'ปกติ ✅' },
    };
    return maps[urgency] || maps.NORMAL;
  }

  private getStatusConfig(status: string) {
    const maps = {
      PENDING: { color: COLORS.WARNING, text: 'รอดำเนินการ' },
      IN_PROGRESS: { color: COLORS.INFO, text: 'กำลังดำเนินการ' },
      COMPLETED: { color: COLORS.SUCCESS, text: 'เสร็จสิ้น' },
      CANCELLED: { color: COLORS.SECONDARY, text: 'ยกเลิก' },
    };
    return maps[status] || { color: COLORS.PRIMARY, text: status };
  }
}