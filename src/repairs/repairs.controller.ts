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
  ParseIntPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { RepairsService } from './repairs.service';
import { CreateRepairTicketDto } from './dto/create-repair-ticket.dto';
import { UpdateRepairTicketDto } from './dto/update-repair-ticket.dto';
import { RepairTicketStatus, UrgencyLevel, ProblemCategory } from '@prisma/client';
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
    @Request() req: any,
    @Body() body: any,
    @UploadedFiles() files?: any[],
  ) {
    const logger = new Logger('RepairsController.createFromLiff');
    
    // DEBUG: Log received data
    logger.log(`Content-Type: ${req.headers['content-type']}`);
    logger.log(`Received Request Body Keys: ${Object.keys(body).join(', ')}`);
    logger.log(`Received Files Count: ${files ? files.length : 0}`);
    if (files && files.length > 0) {
        files.forEach((f, i) => logger.log(`File [${i}]: ${f.originalname} (${f.size} bytes)`));
    }

    try {
      // Extract data from Body (handled by Multer for FormData)
      const createRepairTicketDto = new CreateRepairTicketDto();
      createRepairTicketDto.reporterName = body.reporterName || 'ไม่ได้ระบุ';
      createRepairTicketDto.reporterDepartment = body.reporterDepartment;
      createRepairTicketDto.reporterPhone = body.reporterPhone;
      
      // Clean LINE ID
      let lineId = body.reporterLineId;
      if (!lineId || lineId === 'null' || lineId === 'undefined') {
        lineId = 'Guest';
      }
      createRepairTicketDto.reporterLineId = lineId;
      
      logger.log(`Extracted DTO: Name=${createRepairTicketDto.reporterName}, Dept=${createRepairTicketDto.reporterDepartment}, LineID=${createRepairTicketDto.reporterLineId}`);

      // Validate and fallback for problemCategory
      const validCategories = Object.values(ProblemCategory);
      if (body.problemCategory && validCategories.includes(body.problemCategory as any)) {
        createRepairTicketDto.problemCategory = body.problemCategory as ProblemCategory;
      } else {
        logger.warn(`Invalid or missing problemCategory: ${body.problemCategory}. Falling back to OTHER.`);
        createRepairTicketDto.problemCategory = ProblemCategory.OTHER;
      }
      
      createRepairTicketDto.problemTitle = body.problemTitle || 'ไม่มีหัวข้อ';
      
      // Append Image Categories to Description if present
      let description = body.problemDescription || '';
      if (body.imageCategories) {
        try {
          const categories = typeof body.imageCategories === 'string' ? JSON.parse(body.imageCategories) : body.imageCategories;
          if (Array.isArray(categories) && categories.length > 0) {
            const categoryLabels = {
              monitor: 'หน้าจอ', pc: 'คอมพิวเตอร์', printer: 'เครื่องพิมพ์', 
              network: 'อินเทอร์เน็ต', mouse_keyboard: 'เมาส์/คีย์บอร์ด', software: 'โปรแกรม'
            };
            const labels = categories.map(c => categoryLabels[c] || c).join(', ');
            description += `\n\n[สัญลักษณ์ที่ระบุ: ${labels}]`;
          }
        } catch (e) {
          logger.warn(`Failed to parse imageCategories: ${e.message}`);
        }
      }
      createRepairTicketDto.problemDescription = description;

      createRepairTicketDto.location = body.location || 'ไม่ได้ระบุ';
      createRepairTicketDto.urgency = body.urgency || 'NORMAL';

      logger.log(`Handover to UsersService with LineID: ${lineId}`);

      // Upsert User: Create if new, Update profile if existing
      const { displayName, pictureUrl } = body;
      const user = await this.usersService.getOrCreateUserFromLine(
        lineId,
        displayName,
        pictureUrl,
      );

      const userId = user.id;
      logger.log(`Identified User ID: ${userId} (${user.name})`);

      logger.log('Handover to RepairsService for ticket creation...');
      const ticket = await this.repairsService.create(userId, createRepairTicketDto, files);
      
      if (!ticket) {
        throw new Error('Failed to create ticket record in database');
      }
      
      logger.log(`Ticket Successfully Created: ${ticket.ticketCode}`);

      // ส่ง notification ไปยัง IT team (Async focus)
      try {
        await this.lineNotificationService.notifyRepairTicketToITTeam({
          ticketCode: ticket.ticketCode,
          reporterName: ticket.reporterName,
          department: ticket.reporterDepartment || 'ไม่ระบุ',
          problemTitle: ticket.problemTitle,
          location: ticket.location,
          urgency: ticket.urgency as any,
          createdAt: new Date().toLocaleString('th-TH'),
        });
        logger.log('LINE notification sent to IT team');
      } catch (notifError) {
        logger.error(`Notification failed but ignored: ${notifError.message}`);
      }

      return ticket;
    } catch (error: any) {
      logger.error(`CRITICAL FAILURE in createFromLiff: ${error.message}`);
      if (error.stack) logger.error(error.stack);
      
      if (error instanceof HttpException) throw error;
      
      throw new HttpException({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: `สร้างรายการแจ้งซ่อมไม่สำเร็จ: ${error.message}`,
        error: error.name || 'CREATE_TICKET_ERROR',
      }, HttpStatus.INTERNAL_SERVER_ERROR);
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
    @Query('limit') limit?: string,
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
    if (limit) {
      filters.take = parseInt(limit);
    }

    return this.repairsService.findAll(filters);
  }

  /**
   * Get repair ticket by ID
   */
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.repairsService.findOne(id);
  }

  /**
   * Get repair schedule data
   */
  @Get('schedule')
  async getSchedule() {
    return this.repairsService.getSchedule();
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
    @Param('id', ParseIntPipe) id: number,
    @Body() updateRepairTicketDto: UpdateRepairTicketDto,
    @Request() req: any,
  ) {
    const updatedTicket = await this.repairsService.update(
      id,
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
          {
            ticketCode: updatedTicket.ticketCode,
            problemTitle: updatedTicket.problemTitle,
            problemDescription: updatedTicket.problemDescription || undefined,
            status: updateRepairTicketDto.status,
            remark: updateRepairTicketDto.notes || '',
            updatedAt: new Date(),
            technicianName: updatedTicket.assignee?.name,
          },
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
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.repairsService.remove(id);
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
