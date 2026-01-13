import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LineOAService } from './line-oa.service';
import { LineNotificationStatus } from '@prisma/client';

/* =======================
   ENUMS & CONSTANTS
======================= */

// Use Prisma's LineNotificationStatus instead of local enum
const NotificationStatus = LineNotificationStatus;

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

/* =======================
   INTERFACES
======================= */

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
  urgency: 'CRITICAL' | 'URGENT' | 'NORMAL';
  createdAt: string;
}

export interface RepairStatusUpdatePayload {
  ticketCode: string;
  status: string;
  remark?: string;
  technicianName?: string;
  nextStep?: string;
  updatedAt?: Date;
}

/* =======================
   SERVICE
======================= */

@Injectable()
export class LineOANotificationService {
  private readonly logger = new Logger(LineOANotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineOAService: LineOAService,
  ) {}

  /* =======================
     GENERIC NOTIFICATION
  ======================= */

  async sendNotification(userId: number, payload: LineNotificationPayload) {
    try {
      const lineLink = await this.getVerifiedLineLink(userId);
      if (!lineLink) {
        return { success: false, reason: 'User not linked to LINE' };
      }

      const message =
        payload.richMessage || this.createDefaultTextMessage(payload);

      await this.lineOAService.sendMessage(
        lineLink.lineUserId!,
        message,
      );

      await this.saveNotificationLog(
        lineLink.lineUserId!,
        payload,
        NotificationStatus.SENT,
      );

      return { success: true };
    } catch (error) {
      this.logger.error(error.message);
      await this.logFailure(userId, payload, error.message);
      return { success: false };
    }
  }

  /* =======================
     NOTIFY IT TEAM (NEW TICKET)
  ======================= */

  async notifyRepairTicketToITTeam(
    payload: RepairTicketNotificationPayload,
  ) {
    try {
      const itUsers = await this.prisma.user.findMany({
        where: {
          role: 'IT',
          lineOALink: { status: 'VERIFIED' },
        },
        include: { lineOALink: true },
      });

      const lineUserIds = itUsers
        .map(u => u.lineOALink?.lineUserId)
        .filter((id): id is string => !!id);

      if (lineUserIds.length === 0) {
        return { success: false, reason: 'No IT users linked to LINE' };
      }

      const flexMessage = {
        type: 'flex' as const,
        altText: `📢 งานซ่อมใหม่ ${payload.ticketCode}`,
        contents: this.createRepairTicketFlex(payload) as any,
      };

      await this.lineOAService.sendMulticast(
        lineUserIds,
        flexMessage,
      );

      await Promise.all(
        lineUserIds.map(lineUserId =>
          this.saveNotificationLog(
            lineUserId,
            {
              type: 'REPAIR_TICKET_CREATED',
              title: `งานใหม่ ${payload.ticketCode}`,
              message: payload.problemTitle,
            },
            NotificationStatus.SENT,
          ),
        ),
      );

      return { success: true, count: lineUserIds.length };
    } catch (error) {
      this.logger.error(error.message);
      return { success: false };
    }
  }

  /* =======================
     STATUS UPDATE → REPORTER
  ======================= */

  async notifyRepairTicketStatusUpdate(
    userId: number,
    payload: RepairStatusUpdatePayload,
  ) {
    const lineLink = await this.getVerifiedLineLink(userId);
    if (!lineLink) return { success: false };

    const flexMessage = {
      type: 'flex' as const,
      altText: `🔄 อัปเดตสถานะ ${payload.ticketCode}`,
      contents: this.createStatusUpdateFlex(payload) as any,
    };

    try {
      await this.lineOAService.sendMessage(
        lineLink.lineUserId!,
        flexMessage,
      );

      await this.saveNotificationLog(
        lineLink.lineUserId!,
        {
          type: 'REPAIR_STATUS_UPDATE',
          title: `อัปเดตงาน ${payload.ticketCode}`,
          message: payload.remark || payload.status,
        },
        NotificationStatus.SENT,
      );

      return { success: true };
    } catch (error) {
      this.logger.error(error.message);
      return { success: false };
    }
  }

  /* =======================
     PRIVATE HELPERS
  ======================= */

  private async getVerifiedLineLink(userId: number) {
    const link = await this.prisma.lineOALink.findUnique({
      where: { userId },
    });

    if (!link || link.status !== 'VERIFIED' || !link.lineUserId) {
      return null;
    }
    return link;
  }

  private async saveNotificationLog(
    lineUserId: string,
    payload: Partial<LineNotificationPayload>,
    status: LineNotificationStatus,
    errorMessage?: string,
  ) {
    return this.prisma.lineNotification.create({
      data: {
        lineUserId,
        type: payload.type ?? '',
        title: payload.title ?? '',
        message: payload.message ?? '',
        status,
        errorMessage,
      },
    });
  }

  private async logFailure(
    userId: number,
    payload: LineNotificationPayload,
    error: string,
  ) {
    const link = await this.prisma.lineOALink.findUnique({
      where: { userId },
    });
    if (link?.lineUserId) {
      await this.saveNotificationLog(
        link.lineUserId,
        payload,
        NotificationStatus.FAILED,
        error,
      );
    }
  }

  private createDefaultTextMessage(payload: LineNotificationPayload) {
    return {
      type: 'text',
      text: `📬 ${payload.title}\n\n${payload.message}${
        payload.actionUrl ? `\n\n👉 ${payload.actionUrl}` : ''
      }`,
    };
  }

  /* =======================
     FLEX FACTORIES
  ======================= */

  private createRepairTicketFlex(
    payload: RepairTicketNotificationPayload,
  ) {
    const urgency = this.getUrgencyConfig(payload.urgency);
    const url = `${process.env.FRONTEND_URL}/admin/repairs?id=${payload.ticketCode}`;

    return {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: urgency.color,
        contents: [
          {
            type: 'text',
            text: 'แจ้งซ่อมใหม่',
            color: '#FFFFFF',
            weight: 'bold',
          },
          {
            type: 'text',
            text: urgency.text,
            color: '#FFFFFF',
            size: 'xs',
          },
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
          {
            type: 'button',
            style: 'primary',
            color: urgency.color,
            action: {
              type: 'uri',
              label: 'รับงานซ่อม',
              uri: url,
            },
          },
        ],
      },
    };
  }

  private createStatusUpdateFlex(payload: RepairStatusUpdatePayload) {
    const config = this.getStatusConfig(payload.status);
    const url = `https://liff.line.me/${process.env.LINE_LIFF_ID}?id=${payload.ticketCode}`;
    
    // Format date/time professionally with Thai timezone
    const formattedDate = payload.updatedAt 
      ? new Intl.DateTimeFormat('th-TH', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Bangkok',
        }).format(payload.updatedAt)
      : new Intl.DateTimeFormat('th-TH', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Bangkok',
        }).format(new Date());

    return {
      type: 'bubble',
      size: 'mega',
      styles: {
        header: { backgroundColor: config.color },
        body: { backgroundColor: '#FAFAFA' },
        footer: { backgroundColor: '#F5F5F5' },
      },
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                contents: [
                  {
                    type: 'text',
                    text: 'อัปเดตสถานะงาน',
                    color: '#FFFFFF',
                    weight: 'bold',
                    size: 'md',
                  },
                  {
                    type: 'text',
                    text: payload.ticketCode,
                    color: '#FFFFFF',
                    size: 'sm',
                    margin: 'xs',
                  },
                ],
              },
            ],
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        paddingAll: '20px',
        contents: [
          // Status Badge
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: config.color + '15',
            cornerRadius: '12px',
            paddingAll: '16px',
            contents: [
              {
                type: 'text',
                text: config.text,
                weight: 'bold',
                size: 'xl',
                color: config.color,
                align: 'center',
              },
            ],
          },
          
          // Technician Info Section
          ...(payload.technicianName ? [{
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFFFFF',
            cornerRadius: '8px',
            paddingAll: '12px',
            borderColor: '#E0E0E0',
            borderWidth: '1px',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  {
                    type: 'text',

                    size: 'md',
                    flex: 0,
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 1,
                    paddingStart: '8px',
                    contents: [
                      {
                        type: 'text',
                        text: 'เจ้าหน้าที่รับผิดชอบ',
                        size: 'xs',
                        color: '#888888',
                      },
                      {
                        type: 'text',
                        text: payload.technicianName,
                        size: 'md',
                        weight: 'bold',
                        color: '#333333',
                      },
                    ],
                  },
                ],
              },
            ],
          }] : []),
          
          // Remark Section
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFFFFF',
            cornerRadius: '8px',
            paddingAll: '12px',
            borderColor: '#E0E0E0',
            borderWidth: '1px',
            contents: [
              {
                type: 'text',
                text: 'หมายเหตุจากเจ้าหน้าที่',
                size: 'xs',
                color: '#888888',
                margin: 'none',
              },
              {
                type: 'text',
                text: payload.remark || 'ไม่มีหมายเหตุเพิ่มเติม',
                size: 'sm',
                color: '#333333',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
          
          // Next Step (if any)
          ...(payload.nextStep ? [{
            type: 'box',
            layout: 'horizontal',
            backgroundColor: '#FFF3E0',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              {
                type: 'text',
                size: 'sm',
                flex: 0,
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                paddingStart: '8px',
                contents: [
                  {
                    type: 'text',
                    text: 'ขั้นตอนถัดไป',
                    size: 'xs',
                    color: '#E65100',
                  },
                  {
                    type: 'text',
                    text: payload.nextStep,
                    size: 'sm',
                    color: '#333333',
                    wrap: true,
                  },
                ],
              },
            ],
          }] : []),
          
          // Timestamp
          {
            type: 'box',
            layout: 'horizontal',
            justifyContent: 'flex-end',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: formattedDate,
                size: 'xs',
                color: '#999999',
                align: 'end',
              },
            ],
          },
        ],
      },
      
    };
  }

  private createFlexRow(label: string, value: string, bold = false) {
    return {
      type: 'box',
      layout: 'baseline',
      contents: [
        { type: 'text', text: label, size: 'sm', color: '#AAAAAA', flex: 2 },
        { type: 'text', text: value, size: 'sm', wrap: true, flex: 5, weight: bold ? 'bold' : 'regular' },
      ],
    };
  }

  /* =======================
     MAPPINGS
  ======================= */

  private getUrgencyConfig(level: string) {
    return {
      CRITICAL: { color: COLORS.CRITICAL, text: 'ด่วนที่สุด' },
      URGENT: { color: COLORS.URGENT, text: 'ด่วน' },
      NORMAL: { color: COLORS.NORMAL, text: 'ปกติ' },
    }[level] || { color: COLORS.NORMAL, text: 'ปกติ' };
  }

  private getStatusConfig(status: string) {
    return {
      PENDING: { color: COLORS.WARNING, text: 'รอดำเนินการ' },
      IN_PROGRESS: { color: COLORS.INFO, text: 'กำลังดำเนินการ' },
      COMPLETED: { color: COLORS.SUCCESS, text: 'เสร็จสิ้น' },
      WAITING_USER: { color: COLORS.WARNING, text: 'รอข้อมูลจากผู้แจ้ง' },
      CANCELLED: { color: COLORS.SECONDARY, text: 'ยกเลิก' },
    }[status] || { color: COLORS.PRIMARY, text: status };
  }
}
