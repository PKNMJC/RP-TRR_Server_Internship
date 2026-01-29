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
import {
  RepairTicketStatus,
  UrgencyLevel,
  ProblemCategory,
} from '@prisma/client';
import { LineOANotificationService } from '../line-oa/line-oa-notification.service';
import { UsersService } from '../users/users.service';

@Controller('api/repairs')
export class RepairsController {
  private readonly logger = new Logger(RepairsController.name);

  constructor(
    private readonly repairsService: RepairsService,
    private readonly lineNotificationService: LineOANotificationService,
    private readonly usersService: UsersService,
  ) {}

  /* =====================================================
      LIFF : Create Ticket (Public)
  ===================================================== */

  @SetMetadata('isPublic', true)
  @Post('liff/create')
  @UseInterceptors(FilesInterceptor('files', 3))
  async createFromLiff(
    @Request() req: any,
    @Body() body: Record<string, any>,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    try {
      const dto = new CreateRepairTicketDto();

      dto.reporterName = body.reporterName || 'ไม่ได้ระบุ';
      dto.reporterDepartment = body.reporterDepartment;
      dto.reporterPhone = body.reporterPhone;
      dto.location = body.location || 'ไม่ได้ระบุ';
      dto.problemTitle = body.problemTitle || 'ไม่มีหัวข้อ';

      dto.reporterLineId =
        body.reporterLineId && body.reporterLineId !== 'null'
          ? body.reporterLineId
          : 'Guest';

      dto.problemCategory = Object.values(ProblemCategory).includes(
        body.problemCategory,
      )
        ? body.problemCategory
        : ProblemCategory.OTHER;

      dto.urgency = Object.values(UrgencyLevel).includes(body.urgency)
        ? body.urgency
        : UrgencyLevel.NORMAL;

      dto.problemDescription = body.problemDescription || '';

      const user = await this.usersService.getOrCreateUserFromLine(
        dto.reporterLineId ?? 'Guest',
        body.displayName,
        body.pictureUrl,
      );

      const ticket = await this.repairsService.create(
        user.id,
        dto,
        files,
      );

      if (ticket) {
        // Notify IT (fire & forget)
        this.lineNotificationService
          .notifyRepairTicketToITTeam({
            ticketCode: ticket.ticketCode,
            reporterName: ticket.reporterName,
            department: ticket.reporterDepartment || 'ไม่ระบุ',
            problemTitle: ticket.problemTitle,
            location: ticket.location,
            urgency: ticket.urgency,
            createdAt: new Date().toLocaleString('th-TH'),
          })
          .catch(() => this.logger.warn('IT notify failed'));
      }

      return ticket;
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw new HttpException(
        'สร้างรายการแจ้งซ่อมไม่สำเร็จ',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /* =====================================================
      LIFF : Read
  ===================================================== */

  @SetMetadata('isPublic', true)
  @Get('liff/ticket/:code')
  async getTicketForLiff(
    @Param('code') code: string,
    @Query('lineUserId') lineUserId: string,
  ) {
    if (!lineUserId) {
      throw new HttpException(
        'LINE User ID is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const user = await this.repairsService.findUserByLineId(lineUserId);
    if (!user) {
      throw new HttpException(
        'User not linked to LINE',
        HttpStatus.FORBIDDEN,
      );
    }

    const ticket = await this.repairsService.findByCode(code);

    const isOwner = ticket.userId === user.id;
    const isAdmin = ['ADMIN', 'IT'].includes(user.role);

    if (!isOwner && !isAdmin) {
      throw new HttpException(
        'Permission denied',
        HttpStatus.FORBIDDEN,
      );
    }

    return ticket;
  }

  @SetMetadata('isPublic', true)
  @Get('liff/my-tickets')
  async getLiffUserTickets(@Query('lineUserId') lineUserId: string) {
    if (!lineUserId) {
      throw new HttpException(
        'LINE User ID is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const user = await this.repairsService.findUserByLineId(lineUserId);
    if (!user) return [];

    return this.repairsService.getUserTickets(user.id);
  }

  /* =====================================================
      Protected APIs
  ===================================================== */

  @Post()
  @UseInterceptors(FilesInterceptor('files', 3))
  async create(
    @Request() req: any,
    @Body() dto: CreateRepairTicketDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.repairsService.create(req.user.id, dto, files);
  }

  @Get()
  async findAll(
    @Request() req: any,
    @Query('status') status?: RepairTicketStatus,
    @Query('urgency') urgency?: UrgencyLevel,
    @Query('assignedTo') assignedTo?: string,
  ) {
    const isAdmin = ['ADMIN', 'IT'].includes(req.user.role);

    const filters: any = {};
    if (!isAdmin) filters.userId = req.user.id;
    if (status) filters.status = status;
    if (urgency) filters.urgency = urgency;
    if (assignedTo) filters.assignedTo = Number(assignedTo);

    return this.repairsService.findAll(filters);
  }

  @Get('schedule')
  async getSchedule() {
    return this.repairsService.getSchedule();
  }

  @Get('statistics/overview')
  async getStatistics() {
    return this.repairsService.getStatistics();
  }

  @Get('user/my-tickets')
  async getUserTickets(@Request() req: any) {
    return this.repairsService.getUserTickets(req.user.id);
  }

  @Get('code/:code')
  async findByCode(@Param('code') code: string) {
    return this.repairsService.findByCode(code);
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.repairsService.findOne(id);
  }

  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRepairTicketDto,
    @Request() req: any,
  ) {
    const updated = await this.repairsService.update(
      id,
      dto,
      req.user.id,
    );

    if (dto.status) {
      this.lineNotificationService
        .notifyRepairTicketStatusUpdate(updated.userId, {
          ticketCode: updated.ticketCode,
          problemTitle: updated.problemTitle,
          status: dto.status,
          remark: dto.notes,
          updatedAt: new Date(),
          technicianName: (updated as any).assignee?.name,
        })
        .catch(() => this.logger.warn('User notify failed'));
    }

    return updated;
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.repairsService.remove(id);
  }
}
