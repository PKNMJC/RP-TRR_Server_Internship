import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRepairTicketDto } from './dto/create-repair-ticket.dto';
import { UpdateRepairTicketDto } from './dto/update-repair-ticket.dto';
import { UrgencyLevel, RepairTicketStatus } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class RepairsService {
  private readonly logger = new Logger(RepairsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Generate unique ticket code: REP-YYYYMMDD-XXXX
   */
  private generateTicketCode(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    
    return `REP-${year}${month}${day}-${random}`;
  }

  /**
   * Ensure uploads directory exists
   */
  private ensureUploadsDir(): string {
    const uploadsDir = path.join(process.cwd(), 'uploads', 'repairs');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    return uploadsDir;
  }

  /**
   * Create a new repair ticket
   */
  async create(
    userId: number,
    createRepairTicketDto: CreateRepairTicketDto,
    files?: any[],
  ) {
    const ticketCode = this.generateTicketCode();

    const ticket = await this.prisma.repairTicket.create({
      data: {
        ticketCode,
        reporterName: createRepairTicketDto.reporterName,
        reporterDepartment: createRepairTicketDto.reporterDepartment,
        reporterPhone: createRepairTicketDto.reporterPhone,
        reporterLineId: createRepairTicketDto.reporterLineId,
        problemCategory: createRepairTicketDto.problemCategory,
        problemTitle: createRepairTicketDto.problemTitle,
        problemDescription: createRepairTicketDto.problemDescription,
        location: createRepairTicketDto.location,
        urgency: (createRepairTicketDto.urgency as UrgencyLevel) || UrgencyLevel.NORMAL,
        userId,
        assignedTo: createRepairTicketDto.assignedTo,
        notes: createRepairTicketDto.notes,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            department: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        attachments: true,
        logs: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    // Handle file uploads
    // Handle file uploads
    if (files && files.length > 0) {
      if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
          this.logger.warn('File upload skipped on serverless environment (no persistent storage configured)');
          // Future: Implement S3/Supabase storage here
      } else {
          const uploadsDir = this.ensureUploadsDir();
          const attachments = files.map((file) => {
            const filename = `${ticketCode}-${Date.now()}-${file.originalname}`;
            const filePath = path.join(uploadsDir, filename);
            
            fs.writeFileSync(filePath, file.buffer);
    
            return {
              repairTicketId: ticket.id,
              filename: file.originalname,
              fileUrl: `/uploads/repairs/${filename}`,
              fileSize: file.size,
              mimeType: file.mimetype,
            };
          });
    
          await this.prisma.repairAttachment.createMany({
            data: attachments,
          });
          
          return this.findOne(ticket.id);
      }
    }

    return ticket;
  }

  /**
   * Get all repair tickets
   */
  async findAll(filters?: {
    userId?: number;
    status?: RepairTicketStatus;
    urgency?: UrgencyLevel;
    assignedTo?: number;
  }) {
    const where: any = {};

    if (filters?.userId) {
      where.userId = filters.userId;
    }
    if (filters?.status) {
      where.status = filters.status;
    }
    if (filters?.urgency) {
      where.urgency = filters.urgency;
    }
    if (filters?.assignedTo) {
      where.assignedTo = filters.assignedTo;
    }

    return this.prisma.repairTicket.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            department: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        attachments: true,
        logs: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * Get a single repair ticket by ID
   */
  async findOne(id: number) {
    return this.prisma.repairTicket.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            department: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        attachments: true,
        logs: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });
  }

  /**
   * Get repair ticket by ticket code
   */
  async findByCode(ticketCode: string) {
    return this.prisma.repairTicket.findUnique({
      where: { ticketCode },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            department: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        attachments: true,
        logs: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });
  }

  /**
   * Update repair ticket
   */
  async update(
    id: number,
    updateRepairTicketDto: UpdateRepairTicketDto,
    updatedById: number,
  ) {
    // Create log entry for status change
    if (updateRepairTicketDto.status) {
      await this.prisma.repairTicketLog.create({
        data: {
          repairTicketId: id,
          status: updateRepairTicketDto.status,
          comment: updateRepairTicketDto.notes,
          updatedBy: updatedById,
        },
      });

      // If status is COMPLETED, set completedAt timestamp
      if (updateRepairTicketDto.status === RepairTicketStatus.COMPLETED) {
        updateRepairTicketDto['completedAt'] = new Date();
      }
    }

    const updatedTicket = await this.prisma.repairTicket.update({
      where: { id },
      data: updateRepairTicketDto,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            department: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        attachments: true,
        logs: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    return updatedTicket;
  }

  /**
   * Delete repair ticket
   */
  async remove(id: number) {
    return this.prisma.repairTicket.delete({
      where: { id },
    });
  }

  /**
   * Get user's repair tickets
   */
  async getUserTickets(userId: number) {
    return this.findAll({ userId });
  }

  /**
   * Get tickets assigned to a technician
   */
  async getAssignedTickets(technicianId: number) {
    return this.findAll({ assignedTo: technicianId });
  }

  /**
   * Get statistics
   */
  async getStatistics() {
    const total = await this.prisma.repairTicket.count();
    const pending = await this.prisma.repairTicket.count({
      where: { status: RepairTicketStatus.PENDING },
    });
    const inProgress = await this.prisma.repairTicket.count({
      where: { status: RepairTicketStatus.IN_PROGRESS },
    });
    const waitingParts = await this.prisma.repairTicket.count({
      where: { status: RepairTicketStatus.WAITING_PARTS },
    });
    const completed = await this.prisma.repairTicket.count({
      where: { status: RepairTicketStatus.COMPLETED },
    });
    const cancelled = await this.prisma.repairTicket.count({
      where: { status: RepairTicketStatus.CANCELLED },
    });

    return {
      total,
      pending,
      inProgress,
      waitingParts,
      completed,
      cancelled,
    };
  }

  /**
   * Find user by LINE User ID
   */
  async findUserByLineId(lineUserId: string) {
    // Find LINE OA Link first
    const lineLink = await this.prisma.lineOALink.findFirst({
      where: {
        lineUserId,
        status: 'VERIFIED',
      },
    });

    if (!lineLink) {
      return null;
    }

    // Then find the user
    return this.prisma.user.findUnique({
      where: { id: lineLink.userId },
    });
  }}