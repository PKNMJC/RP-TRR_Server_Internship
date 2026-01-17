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
  problemDescription?: string;
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
    const imageUrl = this.formatImageUrl(payload.imageUrl);
    
    // Debug log for image URL
    this.logger.log(`[StatusUpdate] Original imageUrl: ${payload.imageUrl}`);
    this.logger.log(`[StatusUpdate] Formatted imageUrl: ${imageUrl}`);
    
    const formattedDate = new Intl.DateTimeFormat('th-TH', {
      year: 'numeric', month: 'long', day: 'numeric', 
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok',
    }).format(payload.updatedAt || new Date());

    // Premium Gradient Header Colors
    const headerGradientStart = config.color;

    return {
      type: 'bubble', 
      size: 'giga', // ใช้ขนาดใหญ่สุดเพื่อแสดงข้อมูลได้เต็มที่
      // Hero Image Section - แสดงรูปปัญหาที่ผู้แจ้งแนบมา
      ...(imageUrl ? {
        hero: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'image',
              url: imageUrl,
              size: 'full',
              aspectRatio: '16:9',
              aspectMode: 'cover',
            },
            // Overlay gradient + badge
            {
              type: 'box',
              layout: 'vertical',
              position: 'absolute',
              offsetTop: '0px',
              offsetStart: '0px',
              offsetEnd: '0px',
              paddingAll: '12px',
              background: { type: 'linearGradient', angle: '180deg', startColor: '#00000099', endColor: '#00000000' },
              contents: [
                {
                  type: 'box', layout: 'horizontal', justifyContent: 'space-between', alignItems: 'center',
                  contents: [
                    { type: 'text', text: '📷 ภาพปัญหาที่แจ้ง', color: '#FFFFFF', size: 'xs', weight: 'bold' },
                    {
                      type: 'box', layout: 'vertical', backgroundColor: config.color, cornerRadius: 'md', paddingAll: '4px', paddingStart: '8px', paddingEnd: '8px',
                      contents: [{ type: 'text', text: config.text, color: '#FFFFFF', size: 'xxs', weight: 'bold' }]
                    }
                  ]
                }
              ],
            }
          ],
        }
      } : {}),
      // Header Section
      header: {
        type: 'box', 
        layout: 'vertical', 
        backgroundColor: headerGradientStart,
        paddingAll: '20px',
        contents: [
          // Title Row
          { 
            type: 'box', layout: 'horizontal', justifyContent: 'space-between', alignItems: 'center',
            contents: [
              { 
                type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { type: 'text', text: '🔔', size: 'xl' },
                  { type: 'text', text: 'อัปเดตสถานะ', color: '#FFFFFF', weight: 'bold', size: 'xl' },
                ]
              },
            ]
          },
          // Ticket Code Badge
          { 
            type: 'box', layout: 'horizontal', margin: 'md',
            contents: [
              {
                type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF30', cornerRadius: 'lg', 
                paddingAll: '8px', paddingStart: '14px', paddingEnd: '14px',
                contents: [
                  { type: 'text', text: `🎫 ${payload.ticketCode}`, color: '#FFFFFF', size: 'sm', weight: 'bold' }
                ]
              }
            ]
          },
        ],
      },
      // Body Section
      body: {
        type: 'box', 
        layout: 'vertical', 
        spacing: 'lg', 
        paddingAll: '20px',
        backgroundColor: '#FFFFFF',
        contents: [
          // Status Badge - แสดงสถานะเด่นชัด (ถ้าไม่มีรูป)
          ...(!imageUrl ? [{
            type: 'box', 
            layout: 'vertical', 
            backgroundColor: config.color + '15', 
            cornerRadius: 'xxl', 
            paddingAll: '20px',
            contents: [
              { type: 'text', text: config.emoji, size: '3xl', align: 'center' },
              { type: 'text', text: config.text, weight: 'bold', size: 'xl', color: config.color, align: 'center', margin: 'md' }
            ],
          }] : []),
          // ชื่อปัญหาที่แจ้ง - Premium Card Design
          ...(payload.problemTitle ? [{
            type: 'box', 
            layout: 'vertical', 
            backgroundColor: '#F8FAFC', 
            cornerRadius: 'xl', 
            paddingAll: '16px',
            borderColor: '#E2E8F0', 
            borderWidth: '1px',
            contents: [
              { 
                type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { 
                    type: 'box', layout: 'vertical', backgroundColor: '#3B82F6', cornerRadius: 'md',
                    width: '28px', height: '28px', justifyContent: 'center', alignItems: 'center',
                    contents: [{ type: 'text', text: '🔧', size: 'sm' }]
                  },
                  { type: 'text', text: 'ปัญหาที่แจ้ง', size: 'sm', color: '#64748B', weight: 'bold' }
                ]
              },
              { type: 'text', text: payload.problemTitle, size: 'lg', weight: 'bold', color: '#0F172A', wrap: true, margin: 'md' }
            ],
          }] : []),
          // รายละเอียดปัญหา
          ...(payload.problemDescription ? [{
            type: 'box', 
            layout: 'vertical', 
            backgroundColor: '#F1F5F9', 
            cornerRadius: 'xl', 
            paddingAll: '16px',
            contents: [
              { 
                type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { 
                    type: 'box', layout: 'vertical', backgroundColor: '#8B5CF6', cornerRadius: 'md',
                    width: '28px', height: '28px', justifyContent: 'center', alignItems: 'center',
                    contents: [{ type: 'text', text: '📝', size: 'sm' }]
                  },
                  { type: 'text', text: 'รายละเอียด', size: 'sm', color: '#64748B', weight: 'bold' }
                ]
              },
              { type: 'text', text: payload.problemDescription, size: 'sm', color: '#475569', wrap: true, margin: 'md' }
            ],
          }] : []),
          // Divider with style
          { 
            type: 'box', layout: 'horizontal', margin: 'lg',
            contents: [
              { type: 'box', layout: 'vertical', backgroundColor: '#E2E8F0', height: '1px', flex: 1, contents: [] },
              { type: 'text', text: '👤', size: 'sm', margin: 'md' },
              { type: 'box', layout: 'vertical', backgroundColor: '#E2E8F0', height: '1px', flex: 1, contents: [] },
            ]
          },
          // ข้อมูลเจ้าหน้าที่ - Premium Avatar Card
          ...(payload.technicianName ? [{
            type: 'box', 
            layout: 'horizontal', 
            spacing: 'lg', 
            alignItems: 'center',
            backgroundColor: '#F0FDF4',
            cornerRadius: 'xl',
            paddingAll: '14px',
            borderColor: '#86EFAC',
            borderWidth: '1px',
            contents: [
              { 
                type: 'box', layout: 'vertical', backgroundColor: '#22C55E', cornerRadius: 'xxl', 
                width: '48px', height: '48px', justifyContent: 'center', alignItems: 'center',
                contents: [{ type: 'text', text: '👨‍🔧', size: 'xl' }]
              },
              {
                type: 'box', layout: 'vertical', flex: 1,
                contents: [
                  { type: 'text', text: 'เจ้าหน้าที่ผู้รับผิดชอบ', size: 'xs', color: '#16A34A', weight: 'bold' },
                  { type: 'text', text: payload.technicianName, size: 'lg', weight: 'bold', color: '#166534', margin: 'xs' }
                ]
              },
              { type: 'text', text: '✓', size: 'xl', color: '#22C55E' }
            ],
          }] : [{
            type: 'box', 
            layout: 'horizontal', 
            spacing: 'lg', 
            alignItems: 'center',
            backgroundColor: '#FEF2F2',
            cornerRadius: 'xl',
            paddingAll: '14px',
            borderColor: '#FECACA',
            borderWidth: '1px',
            contents: [
              { 
                type: 'box', layout: 'vertical', backgroundColor: '#FEE2E2', cornerRadius: 'xxl', 
                width: '48px', height: '48px', justifyContent: 'center', alignItems: 'center',
                contents: [{ type: 'text', text: '⏳', size: 'xl' }]
              },
              {
                type: 'box', layout: 'vertical', flex: 1,
                contents: [
                  { type: 'text', text: 'เจ้าหน้าที่ผู้รับผิดชอบ', size: 'xs', color: '#DC2626' },
                  { type: 'text', text: 'รอมอบหมาย', size: 'lg', weight: 'bold', color: '#B91C1C', margin: 'xs' }
                ]
              }
            ],
          }]),
          // หมายเหตุจากเจ้าหน้าที่ - Speech Bubble Style
          ...(payload.remark ? [{
            type: 'box', 
            layout: 'vertical', 
            backgroundColor: '#FFFBEB', 
            cornerRadius: 'xl', 
            paddingAll: '16px',
            borderColor: '#FCD34D', 
            borderWidth: '2px',
            contents: [
              { 
                type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { 
                    type: 'box', layout: 'vertical', backgroundColor: '#F59E0B', cornerRadius: 'md',
                    width: '28px', height: '28px', justifyContent: 'center', alignItems: 'center',
                    contents: [{ type: 'text', text: '💬', size: 'sm' }]
                  },
                  { type: 'text', text: 'ข้อความจากเจ้าหน้าที่', size: 'sm', color: '#92400E', weight: 'bold' }
                ]
              },
              { 
                type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF', cornerRadius: 'lg', 
                paddingAll: '12px', margin: 'md',
                contents: [
                  { type: 'text', text: `"${payload.remark}"`, size: 'md', color: '#78350F', wrap: true, style: 'italic' }
                ]
              }
            ],
          }] : []),
          // สิ่งที่ต้องทำต่อไป
          ...(payload.nextStep ? [{
            type: 'box', 
            layout: 'vertical', 
            backgroundColor: '#ECFDF5', 
            cornerRadius: 'xl', 
            paddingAll: '16px',
            borderColor: '#6EE7B7', 
            borderWidth: '2px',
            contents: [
              { 
                type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
                contents: [
                  { 
                    type: 'box', layout: 'vertical', backgroundColor: '#10B981', cornerRadius: 'md',
                    width: '28px', height: '28px', justifyContent: 'center', alignItems: 'center',
                    contents: [{ type: 'text', text: '➡️', size: 'sm' }]
                  },
                  { type: 'text', text: 'ขั้นตอนถัดไป', size: 'sm', color: '#047857', weight: 'bold' }
                ]
              },
              { type: 'text', text: payload.nextStep, size: 'md', color: '#065F46', wrap: true, margin: 'md', weight: 'bold' }
            ],
          }] : []),
        ],
      },
      // Footer Section - Premium Action Button
      footer: {
        type: 'box', 
        layout: 'vertical', 
        spacing: 'md', 
        paddingAll: '16px',
        backgroundColor: '#F8FAFC',
        contents: [
          // Timestamp
          {
            type: 'box', layout: 'horizontal', justifyContent: 'center', margin: 'none',
            contents: [
              { type: 'text', text: `🕐 อัปเดตเมื่อ ${formattedDate}`, size: 'xs', color: '#94A3B8', align: 'center' }
            ],
          },
          // Action Button
          {
            type: 'button', 
            style: 'primary', 
            color: config.color, 
            height: 'md',
            action: { type: 'uri', label: '📱 ดูรายละเอียดงานซ่อม', uri: url },
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
    if (!url) {
      this.logger.warn('[formatImageUrl] No URL provided');
      return undefined;
    }
    
    if (url.startsWith('data:')) {
      this.logger.warn('[formatImageUrl] Data URI not supported by LINE');
      return undefined; // LINE doesn't support data URIs
    }
    
    if (url.startsWith('http')) {
      this.logger.log(`[formatImageUrl] Already absolute URL: ${url}`);
      return url;
    }
    
    // Get backend URL from environment or use common fallbacks
    const backendUrl = process.env.BACKEND_URL || process.env.FRONTEND_URL?.replace('client', 'api') || '';
    
    if (!backendUrl) {
      this.logger.error('[formatImageUrl] BACKEND_URL not configured! Please set BACKEND_URL in .env');
      return undefined;
    }
    
    // Ensure URL starts with /
    const cleanPath = url.startsWith('/') ? url : `/${url}`;
    const fullUrl = `${backendUrl}${cleanPath}`;
    
    this.logger.log(`[formatImageUrl] Formatted URL: ${fullUrl}`);
    return fullUrl;
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
      PENDING: { color: COLORS.WARNING, text: 'รอดำเนินการ', emoji: '⏳' },
      IN_PROGRESS: { color: COLORS.INFO, text: 'กำลังดำเนินการ', emoji: '🔧' },
      COMPLETED: { color: COLORS.SUCCESS, text: 'เสร็จสิ้น', emoji: '✅' },
      WAITING_USER: { color: COLORS.WARNING, text: 'รอข้อมูลจากผู้แจ้ง', emoji: '📝' },
      CANCELLED: { color: COLORS.SECONDARY, text: 'ยกเลิก', emoji: '❌' },
    }[status] || { color: COLORS.PRIMARY, text: status, emoji: '📋' });
  }
}
