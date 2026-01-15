import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LineOAService } from './line-oa.service';
import { LineNotificationStatus } from '@prisma/client';

/* =======================
   ENUMS & CONSTANTS
======================= */

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
  problemDescription?: string;
  location: string;
  urgency: 'CRITICAL' | 'URGENT' | 'NORMAL';
  createdAt: string;
  imageUrl?: string;
}

export interface RepairStatusUpdatePayload {
  ticketCode: string;
  problemTitle?: string;
  status: string;
  remark?: string;
  technicianName?: string;
  nextStep?: string;
  updatedAt?: Date;
  imageUrl?: string;
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
      if (!lineLink) return { success: false, reason: 'User not linked to LINE' };

      const message = payload.richMessage || this.createDefaultTextMessage(payload);

      await this.lineOAService.sendMessage(lineLink.lineUserId!, message);
      await this.saveNotificationLog(lineLink.lineUserId!, payload, NotificationStatus.SENT);

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

  async notifyRepairTicketToITTeam(payload: RepairTicketNotificationPayload) {
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

      if (lineUserIds.length === 0) return { success: false, reason: 'No IT users linked to LINE' };

      const flexMessage = {
        type: 'flex' as const,
        altText: `📢 งานซ่อมใหม่ ${payload.ticketCode}`,
        contents: this.createRepairTicketFlex(payload) as any,
      };

      await this.lineOAService.sendMulticast(lineUserIds, flexMessage);
      await Promise.all(lineUserIds.map(lineUserId =>
        this.saveNotificationLog(lineUserId, {
          type: 'REPAIR_TICKET_CREATED',
          title: `งานใหม่ ${payload.ticketCode}`,
          message: payload.problemTitle,
        }, NotificationStatus.SENT)
      ));

      return { success: true, count: lineUserIds.length };
    } catch (error) {
      this.logger.error(error.message);
      return { success: false };
    }
  }

  /* =======================
     NOTIFY SPECIFIC TECHNICIAN
  ====================== */

  async notifyTechnicianTaskAssignment(
    technicianId: number,
    payload: {
      ticketCode: string;
      problemTitle: string;
      reporterName: string;
      urgency: 'CRITICAL' | 'URGENT' | 'NORMAL';
      action: 'ASSIGNED' | 'TRANSFERRED' | 'CLAIMED';
      imageUrl?: string;
    }
  ) {
    try {
      const lineLink = await this.getVerifiedLineLink(technicianId);
      if (!lineLink) return { success: false, reason: 'Technician not linked to LINE' };

      const actionText = {
        ASSIGNED: 'ได้รับมอบหมายงานใหม่',
        TRANSFERRED: 'มีการโอนงานมาให้คุณ',
        CLAIMED: 'คุณรับงานซ่อมแล้ว',
      }[payload.action];

      const flexMessage = {
        type: 'flex' as const,
        altText: `📌 ${actionText} ${payload.ticketCode}`,
        contents: this.createTechnicianAssignmentFlex(payload, actionText) as any,
      };

      await this.lineOAService.sendMessage(lineLink.lineUserId!, flexMessage);
      await this.saveNotificationLog(lineLink.lineUserId!, {
        type: `REPAIR_TICKET_${payload.action}`,
        title: actionText,
        message: `${payload.ticketCode}: ${payload.problemTitle}`,
      }, NotificationStatus.SENT);

      return { success: true };
    } catch (error) {
      this.logger.error(error.message);
      return { success: false };
    }
  }

  /* =======================
     STATUS UPDATE → REPORTER
  ======================= */

  async notifyRepairTicketStatusUpdate(userId: number, payload: RepairStatusUpdatePayload) {
    const lineLink = await this.getVerifiedLineLink(userId);
    if (!lineLink) return { success: false };

    const flexMessage = {
      type: 'flex' as const,
      altText: `🔄 อัปเดตสถานะ ${payload.ticketCode}`,
      contents: this.createStatusUpdateFlex(payload) as any,
    };

    try {
      await this.lineOAService.sendMessage(lineLink.lineUserId!, flexMessage);
      await this.saveNotificationLog(lineLink.lineUserId!, {
        type: 'REPAIR_STATUS_UPDATE',
        title: `อัปเดตงาน ${payload.ticketCode}`,
        message: payload.remark || payload.status,
      }, NotificationStatus.SENT);
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
    const link = await this.prisma.lineOALink.findUnique({ where: { userId } });
    return (link && link.status === 'VERIFIED' && link.lineUserId) ? link : null;
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

  private async logFailure(userId: number, payload: LineNotificationPayload, error: string) {
    const link = await this.prisma.lineOALink.findUnique({ where: { userId } });
    if (link?.lineUserId) {
      await this.saveNotificationLog(link.lineUserId, payload, NotificationStatus.FAILED, error);
    }
  }

  private createDefaultTextMessage(payload: LineNotificationPayload) {
    return {
      type: 'text',
      text: `📬 ${payload.title}\n\n${payload.message}${payload.actionUrl ? `\n\n👉 ${payload.actionUrl}` : ''}`,
    };
  }

  /* =======================
     FLEX FACTORIES
  ======================= */

  private createRepairTicketFlex(payload: RepairTicketNotificationPayload) {
    const urgency = this.getUrgencyConfig(payload.urgency);
    const url = `${process.env.FRONTEND_URL}/admin/repairs?id=${payload.ticketCode}`;
    const imageUrl = this.formatImageUrl(payload.imageUrl);

    return {
      type: 'bubble',
      size: 'mega',
      ...(imageUrl ? {
        hero: {
          type: 'image',
          url: imageUrl,
          size: 'full',
          aspectRatio: '20:13',
          aspectMode: 'cover',
        }
      } : {}),
      header: {
        type: 'box', layout: 'vertical', backgroundColor: urgency.color,
        contents: [
          { type: 'text', text: '📢 แจ้งซ่อมใหม่', color: '#FFFFFF', weight: 'bold', size: 'md' },
          { type: 'text', text: payload.ticketCode, color: '#FFFFFF', size: 'xs', opacity: '0.8' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: payload.problemTitle, weight: 'bold', size: 'lg', wrap: true },
          { 
            type: 'box', layout: 'vertical', backgroundColor: urgency.color + '15',
            paddingAll: '4px', cornerRadius: 'sm', margin: 'sm',
            contents: [{ type: 'text', text: urgency.text, color: urgency.color, size: 'xs', align: 'center', weight: 'bold' }]
          },
          { type: 'separator', margin: 'md' },
          this.createFlexRow('ผู้แจ้ง', payload.reporterName),
          this.createFlexRow('แผนก', payload.department),
          this.createFlexRow('สถานที่', payload.location),
          this.createFlexRow('สถานะ', 'รอดำเนินการ', true),
          { type: 'separator', margin: 'md' },
          {
            type: 'box', layout: 'vertical', margin: 'md',
            contents: [
              { type: 'text', text: 'ยังไม่มีผู้รับผิดชอบ', size: 'sm', color: '#FF0000', align: 'center', weight: 'bold', decoration: 'none' }
            ]
          }
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [
          {
            type: 'button', style: 'primary', color: urgency.color,
            action: { type: 'uri', label: 'รับงานซ่อม (Claim)', uri: url },
          },
        ],
      },
    };
  }

  private createTechnicianAssignmentFlex(payload: any, actionText: string) {
    const urgency = this.getUrgencyConfig(payload.urgency);
    const url = `${process.env.FRONTEND_URL}/it/repairs?id=${payload.ticketCode}`;
    const imageUrl = this.formatImageUrl(payload.imageUrl);

    return {
      type: 'bubble', size: 'mega',
      ...(imageUrl ? {
        hero: {
          type: 'image',
          url: imageUrl,
          size: 'full',
          aspectRatio: '20:13',
          aspectMode: 'cover',
        }
      } : {}),
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#111827',
        contents: [
          { type: 'text', text: `📌 ${actionText}`, color: '#FFFFFF', weight: 'bold', size: 'md' },
          { type: 'text', text: payload.ticketCode, color: '#FFFFFF', size: 'xs', opacity: '0.8' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: payload.problemTitle, weight: 'bold', size: 'lg', wrap: true },
          { 
            type: 'box', layout: 'vertical', backgroundColor: urgency.color + '15',
            paddingAll: '4px', cornerRadius: 'sm',
            contents: [{ type: 'text', text: urgency.text, color: urgency.color, size: 'xs', align: 'center', weight: 'bold' }]
          },
          { type: 'separator' },
          this.createFlexRow('ผู้แจ้ง', payload.reporterName),
          this.createFlexRow('สถานะ', 'รอดำเนินการ (จ่ายงานแล้ว)', true),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'button', style: 'primary', color: '#111827',
          action: { type: 'uri', label: 'ดูรายละเอียดงาน', uri: url },
        }],
      },
    };
  }

  private createStatusUpdateFlex(payload: RepairStatusUpdatePayload) {
    const config = this.getStatusConfig(payload.status);
    const url = `https://liff.line.me/${process.env.LINE_LIFF_ID}?id=${payload.ticketCode}`;
    const formattedDate = new Intl.DateTimeFormat('th-TH', {
      year: 'numeric', month: 'long', day: 'numeric', 
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok',
    }).format(payload.updatedAt || new Date());

    return {
      type: 'bubble', size: 'mega',
      styles: { header: { backgroundColor: config.color }, body: { backgroundColor: '#FAFAFA' }, footer: { backgroundColor: '#F5F5F5' } },
      header: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
          { type: 'text', text: 'อัปเดตสถานะงาน', color: '#FFFFFF', weight: 'bold', size: 'md' },
          { type: 'text', text: payload.ticketCode, color: '#FFFFFF', size: 'sm', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'lg', paddingAll: '20px',
        contents: [
          {
            type: 'box', layout: 'vertical', backgroundColor: config.color + '15', cornerRadius: '12px', paddingAll: '16px',
            contents: [{ type: 'text', text: config.text, weight: 'bold', size: 'xl', color: config.color, align: 'center' }],
          },
          ...(payload.technicianName ? [{
            type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF', cornerRadius: '8px', paddingAll: '12px', borderColor: '#E0E0E0', borderWidth: '1px',
            contents: [
                { type: 'text', text: 'เจ้าหน้าที่รับผิดชอบ', size: 'xs', color: '#888888' },
                { type: 'text', text: payload.technicianName, size: 'md', weight: 'bold', color: '#333333' }
            ],
          }] : []),
          {
            type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF', cornerRadius: '8px', paddingAll: '12px', borderColor: '#E0E0E0', borderWidth: '1px',
            contents: [
              { type: 'text', text: 'หมายเหตุจากเจ้าหน้าที่', size: 'xs', color: '#888888' },
              { type: 'text', text: payload.remark || 'ไม่มีหมายเหตุเพิ่มเติม', size: 'sm', color: '#333333', wrap: true, margin: 'sm' },
            ],
          },
          {
            type: 'box', layout: 'horizontal', justifyContent: 'flex-end', margin: 'md',
            contents: [{ type: 'text', text: formattedDate, size: 'xs', color: '#999999', align: 'end' }],
          },
        ],
      },
    };
  }

  private createFlexRow(label: string, value: string, bold = false) {
    return {
      type: 'box', layout: 'baseline',
      contents: [
        { type: 'text', text: label, size: 'sm', color: '#AAAAAA', flex: 2 },
        { type: 'text', text: value, size: 'sm', wrap: true, flex: 5, weight: bold ? 'bold' : 'regular' },
      ],
    };
  }

  private formatImageUrl(url?: string): string | undefined {
    if (!url) return undefined;
    if (url.startsWith('data:')) return undefined; // LINE doesn't support data URIs
    if (url.startsWith('http')) return url;
    
    const baseUrl = process.env.BACKEND_URL || '';
    return `${baseUrl}${url}`;
  }

  private getUrgencyConfig(level: string) {
    return ({
      CRITICAL: { color: COLORS.CRITICAL, text: 'ด่วนที่สุด' },
      URGENT: { color: COLORS.URGENT, text: 'ด่วน' },
      NORMAL: { color: COLORS.NORMAL, text: 'ปกติ' },
    }[level] || { color: COLORS.NORMAL, text: 'ปกติ' });
  }

  private getStatusConfig(status: string) {
    return ({
      PENDING: { color: COLORS.WARNING, text: 'รอดำเนินการ' },
      IN_PROGRESS: { color: COLORS.INFO, text: 'กำลังดำเนินการ' },
      COMPLETED: { color: COLORS.SUCCESS, text: 'เสร็จสิ้น' },
      WAITING_USER: { color: COLORS.WARNING, text: 'รอข้อมูลจากผู้แจ้ง' },
      CANCELLED: { color: COLORS.SECONDARY, text: 'ยกเลิก' },
    }[status] || { color: COLORS.PRIMARY, text: status });
  }
}
