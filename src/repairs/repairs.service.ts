import {
  Injectable,
  Logger,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRepairTicketDto } from './dto/create-repair-ticket.dto';
import { UpdateRepairTicketDto } from './dto/update-repair-ticket.dto';
import { UrgencyLevel, RepairTicketStatus } from '@prisma/client';
import { LineOANotificationService } from '../line-oa/line-oa-notification.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class RepairsService {
  private readonly logger = new Logger(RepairsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineNotificationService: LineOANotificationService,
  ) {}

  /* =========================
      Utils
  ========================= */

  private generateTicketCode(): string {
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = now.getTime().toString().slice(-5);
    return `REP-${ymd}-${rand}`;
  }

  private ensureUploadsDir(): string {
    const dir = path.join(process.cwd(), 'uploads', 'repairs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /* =========================
      Create
  ========================= */

  async create(
    userId: number,
    dto: CreateRepairTicketDto,
    files?: Express.Multer.File[],
  ) {
    const ticketCode = this.generateTicketCode();
    const isServerless =
      process.env.VERCEL || process.env.NODE_ENV === 'production';

    try {
      return await this.prisma.$transaction(async (tx) => {
        const ticket = await tx.repairTicket.create({
          data: {
            ticketCode,
            reporterName: dto.reporterName,
            reporterDepartment: dto.reporterDepartment,
            reporterPhone: dto.reporterPhone,
            reporterLineId: dto.reporterLineId,
            problemCategory: dto.problemCategory,
            problemTitle: dto.problemTitle,
            problemDescription: dto.problemDescription,
            location: dto.location,
            urgency: dto.urgency ?? UrgencyLevel.NORMAL,
            userId,
            assignedTo: dto.assignedTo,
            notes: dto.notes,
            scheduledAt: dto.scheduledAt ?? new Date(),
          },
        });

        if (files?.length) {
          const attachments: any[] = [];

          for (const file of files) {
            if (!file?.buffer) continue;

            if (isServerless) {
              attachments.push({
                repairTicketId: ticket.id,
                filename: file.originalname,
                fileUrl: `data:${file.mimetype};base64,${file.buffer.toString(
                  'base64',
                )}`,
                fileSize: file.size,
                mimeType: file.mimetype,
              });
            } else {
              const uploadDir = this.ensureUploadsDir();
              const safeName = file.originalname.replace(
                /[^a-zA-Z0-9.-]/g,
                '_',
              );
              const filename = `${ticketCode}-${Date.now()}-${safeName}`;
              const filePath = path.join(uploadDir, filename);

              fs.writeFileSync(filePath, file.buffer);

              attachments.push({
                repairTicketId: ticket.id,
                filename: file.originalname,
                fileUrl: `/uploads/repairs/${filename}`,
                fileSize: file.size,
                mimeType: file.mimetype,
              });
            }
          }

          if (attachments.length) {
            await tx.repairAttachment.createMany({ data: attachments });
          }
        }

        return tx.repairTicket.findUnique({
          where: { id: ticket.id },
          include: {
            user: true,
            assignee: true,
            attachments: true,
            logs: { orderBy: { createdAt: 'desc' } },
          },
        });
      });
    } catch (error) {
      this.logger.error(error.message, error.stack);
      throw new HttpException(
        'ไม่สามารถสร้างใบแจ้งซ่อมได้',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /* =========================
      Read
  ========================= */

  async findAll(filters?: {
    userId?: number;
    status?: RepairTicketStatus;
    urgency?: UrgencyLevel;
    assignedTo?: number;
  }) {
    return this.prisma.repairTicket.findMany({
      where: { ...filters },
      include: {
        user: true,
        assignee: true,
        attachments: true,
        logs: {
          include: { user: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: {
        user: true,
        assignee: true,
        attachments: true,
        logs: {
          include: { user: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!ticket) {
      throw new NotFoundException(`Repair ticket #${id} not found`);
    }

    return ticket;
  }

  async findByCode(ticketCode: string) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { ticketCode },
      include: {
        user: true,
        assignee: true,
        attachments: true,
        logs: {
          include: { user: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!ticket) {
      throw new NotFoundException(`Ticket ${ticketCode} not found`);
    }

    return ticket;
  }

  /* =========================
      Update
  ========================= */

  async update(
    id: number,
    dto: UpdateRepairTicketDto,
    updatedById: number,
  ) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: { assignee: true },
    });

    if (!ticket) {
      throw new NotFoundException(`Repair ticket #${id} not found`);
    }

    const assignedTo =
      dto.assignedTo !== undefined ? Number(dto.assignedTo) : undefined;

    if (dto.status || assignedTo !== undefined) {
      let comment = dto.notes;

      if (assignedTo !== undefined && assignedTo !== ticket.assignedTo) {
        const newAssignee = await this.prisma.user.findUnique({
          where: { id: assignedTo },
        });

        comment =
          `โอนงานจาก ${ticket.assignee?.name ?? 'ไม่มีผู้รับผิดชอบ'} ` +
          `ไปยัง ${newAssignee?.name ?? 'ไม่ทราบชื่อ'}` +
          (comment ? ` | ${comment}` : '');
      }

      await this.prisma.repairTicketLog.create({
        data: {
          repairTicketId: id,
          status: dto.status ?? ticket.status,
          comment:
            comment ??
            `เปลี่ยนสถานะเป็น ${dto.status ?? ticket.status}`,
          updatedBy: updatedById,
        },
      });
    }

    const updated = await this.prisma.repairTicket.update({
      where: { id },
      data: {
        ...dto,
        assignedTo,
        completedAt:
          dto.status === RepairTicketStatus.COMPLETED
            ? new Date()
            : undefined,
        scheduledAt:
          typeof dto.scheduledAt === 'string'
            ? new Date(dto.scheduledAt)
            : dto.scheduledAt,
      },
      include: {
        user: true,
        assignee: true,
        attachments: true,
        logs: { orderBy: { createdAt: 'desc' } },
      },
    });

    const updatedAny = updated as any;

    if (assignedTo && updatedAny.assignee) {
      try {
        await this.lineNotificationService.notifyTechnicianTaskAssignment(
          assignedTo,
          {
            ticketCode: updated.ticketCode,
            problemTitle: updated.problemTitle,
            reporterName:
              updated.reporterName ?? updatedAny.user?.name ?? 'ไม่ระบุ',
            urgency: updated.urgency as any,
            action: 'ASSIGNED',
            imageUrl: updatedAny.attachments?.[0]?.fileUrl,
          },
        );
      } catch (e) {
        this.logger.warn('LINE OA notify failed');
      }
    }

    return updated;
  }

  /* =========================
      Delete (Soft)
  ========================= */

  async remove(id: number) {
    return this.prisma.repairTicket.update({
      where: { id },
      data: {
        status: RepairTicketStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });
  }

  /* =========================
      Others
  ========================= */

  async getStatistics() {
    const [total, pending, inProgress, waitingParts, completed, cancelled] =
      await Promise.all([
        this.prisma.repairTicket.count(),
        this.prisma.repairTicket.count({
          where: { status: RepairTicketStatus.PENDING },
        }),
        this.prisma.repairTicket.count({
          where: { status: RepairTicketStatus.IN_PROGRESS },
        }),
        this.prisma.repairTicket.count({
          where: { status: RepairTicketStatus.WAITING_PARTS },
        }),
        this.prisma.repairTicket.count({
          where: { status: RepairTicketStatus.COMPLETED },
        }),
        this.prisma.repairTicket.count({
          where: { status: RepairTicketStatus.CANCELLED },
        }),
      ]);

    return {
      total,
      pending,
      inProgress,
      waitingParts,
      completed,
      cancelled,
    };
  }

  async getSchedule() {
    return this.prisma.repairTicket.findMany({
      select: {
        id: true,
        ticketCode: true,
        problemTitle: true,
        status: true,
        urgency: true,
        scheduledAt: true,
        location: true,
      },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  /* =========================
      User-related methods
  ========================= */

  async findUserByLineId(lineUserId: string) {
    const link = await this.prisma.lineOALink.findFirst({
      where: { lineUserId },
      include: { user: true },
    });
    return link?.user;
  }

  async getUserTickets(userId: number) {
    return this.prisma.repairTicket.findMany({
      where: { userId },
      include: {
        user: true,
        assignee: true,
        attachments: true,
        logs: {
          include: { user: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
