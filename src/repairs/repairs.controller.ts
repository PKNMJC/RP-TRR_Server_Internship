import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Put,
  Request,
  UseInterceptors,
  UploadedFiles,
  Query,
  Injectable,
  SetMetadata,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { RepairsService } from './repairs.service';
import { CreateRepairTicketDto } from './dto/create-repair-ticket.dto';
import { UpdateRepairTicketDto } from './dto/update-repair-ticket.dto';
import { RepairTicketStatus, UrgencyLevel } from '@prisma/client';
import { LineOANotificationService } from '../line-oa/line-oa-notification.service';
import { UsersService } from '../users/users.service';

@Controller('api/repairs')
export class RepairsController {
  constructor(
    private repairsService: RepairsService,
    private lineNotificationService: LineOANotificationService,
    private usersService: UsersService,
  ) {}

  /**
   * Create a new repair ticket (Public endpoint for LINE LIFF)
   */
  @SetMetadata('isPublic', true)
  @Post('liff/create')
  @UseInterceptors(FilesInterceptor('files', 3))
  async createFromLiff(
    @Body() body: any,
    @UploadedFiles() files?: any[],
  ) {
    const logger = new Logger('RepairsController.createFromLiff');
    
    try {
      // Extract data from FormData
      const createRepairTicketDto = new CreateRepairTicketDto();
      createRepairTicketDto.reporterName = body.reporterName;
      createRepairTicketDto.reporterDepartment = body.reporterDepartment;
      createRepairTicketDto.reporterPhone = body.reporterPhone;
      createRepairTicketDto.reporterLineId = body.reporterLineId;
      createRepairTicketDto.problemCategory = body.problemCategory;
      createRepairTicketDto.problemTitle = body.problemTitle;
      createRepairTicketDto.problemDescription = body.problemDescription;
      createRepairTicketDto.location = body.location;
      createRepairTicketDto.urgency = body.urgency;

      logger.log('LIFF form received:', { 
        lineId: createRepairTicketDto.reporterLineId,
        name: createRepairTicketDto.reporterName,
        problem: createRepairTicketDto.problemTitle,
      });

      // ค้นหา user โดย LINE User ID
      let userId: number;
      
      let user: any = null;

      if (createRepairTicketDto.reporterLineId) {
         user = await this.repairsService.findUserByLineId(
          createRepairTicketDto.reporterLineId
        );
        
        if (!user) {
          logger.log(`User not found for LINE ID ${createRepairTicketDto.reporterLineId}. Auto-creating user...`);
          try {
            user = await this.usersService.createUserFromLineId(
              createRepairTicketDto.reporterLineId
            );
          } catch (createError) {
             logger.error('Failed to auto-create user, falling back to guest:', createError);
          }
        }
      }

      // If still no user (no Line ID provided OR auto-create failed), use Guest
      if (!user) {
        logger.log('Using Guest User for ticket creation');
        user = await this.usersService.getOrCreateGuestUser();
      }

      userId = user!.id;
      logger.log(`Creating ticket for user ${userId}`);

      const ticket = await this.repairsService.create(userId, createRepairTicketDto, files);
      logger.log(`Ticket created: ${ticket!.ticketCode}`);

      // ส่ง notification ไปยัง IT team
      if (ticket) {
        try {
          await this.lineNotificationService.notifyRepairTicketToITTeam({
            ticketCode: ticket.ticketCode,
            reporterName: ticket.reporterName,
            department: ticket.reporterDepartment || 'ไม่ระบุ',
            problemTitle: ticket.problemTitle,
            location: ticket.location,
            urgency: ticket.urgency,
            createdAt: new Date().toLocaleString('th-TH'),
          });
          logger.log('LINE notification sent');
        } catch (error) {
          logger.error('Failed to send LINE notification:', error);
          // Don't throw - ticket is already created
        }
      }

      return ticket;
    } catch (error) {
      logger.error('Error in createFromLiff:', error);
      
      // If already an HttpException, re-throw it
      if (error instanceof HttpException) {
        throw error;
      }
      
      // Otherwise wrap in 500 with details
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: error.message || 'Internal server error',
          error: error.name || 'INTERNAL_ERROR',
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get ticket details for LIFF (Public endpoint with LINE ID verification)
   */
  @SetMetadata('isPublic', true)
  @Get('liff/ticket/:code')
  async getTicketForLiff(
    @Param('code') code: string,
    @Query('lineUserId') lineUserId: string,
  ) {
    const logger = new Logger('RepairsController.getTicketForLiff');
    
    if (!lineUserId) {
      throw new HttpException(
        'LINE User ID is required',
        HttpStatus.BAD_REQUEST
      );
    }

    // 1. Find user by LINE ID to verify identity
    const user = await this.repairsService.findUserByLineId(lineUserId);
    if (!user) {
       throw new HttpException(
        'User not found or not linked to LINE',
        HttpStatus.FORBIDDEN
      );
    }

    // 2. Find ticket
    const ticket = await this.repairsService.findByCode(code);
    if (!ticket) {
      throw new HttpException(
        'Ticket not found',
        HttpStatus.NOT_FOUND
      );
    }

    // 3. Verify ownership (allow if user is owner OR user is IT/Admin)
    const isOwner = ticket.userId === user.id;
    const isAdmin = user.role === 'ADMIN' || user.role === 'IT';

    if (!isOwner && !isAdmin) {
      throw new HttpException(
        'You do not have permission to view this ticket',
        HttpStatus.FORBIDDEN
      );
    }

    return ticket;
  }

  /**
   * Get user tickets for LIFF (Public endpoint with LINE ID verification)
   */
  @SetMetadata('isPublic', true)
  @Get('liff/my-tickets')
  async getLiffUserTickets(@Query('lineUserId') lineUserId: string) {
    if (!lineUserId) {
      throw new HttpException(
        'LINE User ID is required',
        HttpStatus.BAD_REQUEST
      );
    }

    const user = await this.repairsService.findUserByLineId(lineUserId);
    if (!user) {
      return []; // Return empty if user not found (not linked yet)
    }

    return this.repairsService.getUserTickets(user.id);
  }

  /**
   * Create a new repair ticket (Protected endpoint for authenticated users)
   */
  @Post()
  @UseInterceptors(FilesInterceptor('files', 3))
  async create(
    @Request() req: any,
    @Body() createRepairTicketDto: CreateRepairTicketDto,
    @UploadedFiles() files?: any[],
  ) {
    const ticket = await this.repairsService.create(req.user.id, createRepairTicketDto, files);

    // ส่ง notification ไปยัง IT team
    if (ticket) {
      try {
        await this.lineNotificationService.notifyRepairTicketToITTeam({
          ticketCode: ticket.ticketCode,
          reporterName: ticket.reporterName,
          department: ticket.reporterDepartment || 'ไม่ระบุ',
          problemTitle: ticket.problemTitle,
          location: ticket.location,
          urgency: ticket.urgency,
          createdAt: new Date().toLocaleString('th-TH'),
        });
      } catch (error) {
        console.error('Failed to send LINE notification:', error);
        // ไม่ throw error, เพราะ ticket ถูกสร้างแล้ว
      }
    }

    return ticket;
  }

  /**
   * Get all repair tickets
   */
  @Get()
  async findAll(
    @Request() req: any,
    @Query('status') status?: RepairTicketStatus,
    @Query('urgency') urgency?: UrgencyLevel,
    @Query('assignedTo') assignedTo?: string,
  ) {
    const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'IT';

    const filters: any = {};
    if (!isAdmin) {
      filters.userId = req.user.id;
    }
    if (status) {
      filters.status = status;
    }
    if (urgency) {
      filters.urgency = urgency;
    }
    if (assignedTo) {
      filters.assignedTo = parseInt(assignedTo);
    }

    return this.repairsService.findAll(filters);
  }

  /**
   * Get repair ticket by ID
   */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.repairsService.findOne(parseInt(id));
  }

  /**
   * Get repair ticket by code
   */
  @Get('code/:code')
  async findByCode(@Param('code') code: string) {
    return this.repairsService.findByCode(code);
  }

  /**
   * Update repair ticket
   */
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updateRepairTicketDto: UpdateRepairTicketDto,
    @Request() req: any,
  ) {
    const updatedTicket = await this.repairsService.update(
      parseInt(id),
      updateRepairTicketDto,
      req.user.id,
    );

    // ถ้าเปลี่ยนสถานะ ให้ส่ง notification ไปผู้แจ้ง
    if (updateRepairTicketDto.status && updatedTicket.userId) {
      try {
        const statusMessages = {
          PENDING: 'รอดำเนินการ',
          IN_PROGRESS: 'กำลังดำเนินการ',
          WAITING_PARTS: 'รอชิ้นส่วน',
          COMPLETED: 'เสร็จสิ้น ✅',
          CANCELLED: 'ยกเลิก',
        };

        await this.lineNotificationService.notifyRepairTicketStatusUpdate(
          updatedTicket.userId,
          updatedTicket.ticketCode,
          updateRepairTicketDto.status,
          `${statusMessages[updateRepairTicketDto.status]}\n${updateRepairTicketDto.notes || ''}`,
        );
      } catch (error) {
        console.error('Failed to send status update notification:', error);
      }
    }

    return updatedTicket;
  }

  /**
   * Delete repair ticket
   */
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.repairsService.remove(parseInt(id));
  }

  /**
   * Get user's repair tickets
   */
  @Get('user/my-tickets')
  async getUserTickets(@Request() req: any) {
    return this.repairsService.getUserTickets(req.user.id);
  }

  /**
   * Get statistics
   */
  @Get('statistics/overview')
  async getStatistics() {
    return this.repairsService.getStatistics();
  }
}
