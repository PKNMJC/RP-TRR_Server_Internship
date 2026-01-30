import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RepairTicketStatus, UrgencyLevel } from '@prisma/client';

@Injectable()
export class RepairsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: any, files?: Express.Multer.File[]) {
    const ticketCode = `REP-${Date.now()}`;
    // Simple implementation for now to restore functionality
    const ticket = await this.prisma.repairTicket.create({
      data: {
        ticketCode,
        reporterName: dto.reporterName,
        reporterDepartment: dto.reporterDepartment || null,
        reporterPhone: dto.reporterPhone || null,
        reporterLineId: dto.reporterLineId || null,
        problemCategory: dto.problemCategory,
        problemTitle: dto.problemTitle,
        problemDescription: dto.problemDescription || null,
        location: dto.location,
        urgency: dto.urgency || UrgencyLevel.NORMAL,
        userId,
        // assignedTo: dto.assignedTo, // Optional
        notes: dto.notes || null,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : new Date(),
      },
    });
    return ticket;
  }

  async findOne(id: number) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: {
        user: true,
        assignee: true,
        attachments: true,
        logs: { include: { user: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!ticket) throw new NotFoundException(`Repair ticket #${id} not found`);
    return ticket;
  }

  async findByCode(ticketCode: string) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { ticketCode },
      include: {
        user: true,
        assignee: true,
        attachments: true,
        logs: { include: { user: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketCode} not found`);
    return ticket;
  }

  async update(id: number, dto: any, updatedById: number) {
    // Build update data with only valid fields
    const updateData: any = {};

    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.notes !== undefined) updateData.notes = dto.notes;
    // Dates need careful handling
    if (dto.scheduledAt) updateData.scheduledAt = new Date(dto.scheduledAt);
    if (dto.completedAt) updateData.completedAt = new Date(dto.completedAt);
    
    if (dto.problemTitle !== undefined) updateData.problemTitle = dto.problemTitle;
    if (dto.problemDescription !== undefined) updateData.problemDescription = dto.problemDescription;
    if (dto.location !== undefined) updateData.location = dto.location;
    if (dto.urgency !== undefined) updateData.urgency = dto.urgency;
    
    // Explicitly handle assignedTo
    if (dto.assignedTo !== undefined) {
      // If null, we want to set it to null (disconnect)
      // If number, we set it to number
      updateData.assignedTo = dto.assignedTo;
    }

    try {
      const ticket = await this.prisma.repairTicket.update({
        where: { id },
        data: updateData,
        include: {
          user: true,
          assignee: true,
        },
      });
      return ticket;
    } catch (error: any) {
      // Handle "Record not found" error
      if (error.code === 'P2025') {
        throw new NotFoundException(`Repair ticket #${id} not found`);
      }
      // Handle "Foreign Key Constraint failed" (e.g. assignedTo user doesn't exist)
      if (error.code === 'P2003') {
        throw new BadRequestException(`ข้อมูลอ้างอิงไม่ถูกต้อง (เช่น ผู้รับผิดชอบไม่มีอยู่ในระบบ)`);
      }
      throw error;
    }
  }

  async remove(id: number) {
    return this.prisma.repairTicket.update({
        where: { id },
        data: { status: RepairTicketStatus.CANCELLED, cancelledAt: new Date() }
    });
  }

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
        problemDescription: true,
        status: true,
        urgency: true,
        scheduledAt: true,
        createdAt: true,
        completedAt: true,
        location: true,
        reporterName: true,
      },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async findAll(params: {
    userId?: number;
    isAdmin?: boolean;
    status?: RepairTicketStatus;
    urgency?: UrgencyLevel;
    assignedTo?: number;
    limit?: number;
  }) {
    const {
      userId,
      isAdmin,
      status,
      urgency,
      assignedTo,
      limit,
    } = params;

    const where: any = {};

    // 🔐 USER เห็นเฉพาะของตัวเอง
    if (!isAdmin && userId) {
      where.userId = userId;
    }

    if (status) where.status = status;
    if (urgency) where.urgency = urgency;
    if (assignedTo) where.assignedTo = assignedTo;

    return this.prisma.repairTicket.findMany({
      where,
      take: limit,
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
