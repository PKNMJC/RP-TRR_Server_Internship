import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RepairsService } from './repairs.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RepairTicketStatus, UrgencyLevel, Role } from '@prisma/client';

@Controller('api/repairs')
@UseGuards(JwtAuthGuard)
export class RepairsController {
  constructor(private readonly repairsService: RepairsService) {}

  @Get()
  async findAll(
    @Req() req,
    @Query('status') status?: RepairTicketStatus,
    @Query('urgency') urgency?: UrgencyLevel,
    @Query('assignedTo') assignedTo?: string,
    @Query('limit') limit?: string,
  ) {
    const user = req.user;

    return this.repairsService.findAll({
      userId: user.id,
      isAdmin: user.role === Role.ADMIN || user.role === Role.IT,
      status,
      urgency,
      assignedTo: assignedTo ? Number(assignedTo) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  async create(@Req() req, @Body() dto: any) {
    return this.repairsService.create(req.user.id, dto);
  }

  @Get('schedule')
  async getSchedule() {
    return this.repairsService.getSchedule();
  }

  @Get('statistics/overview')
  async getStatistics() {
    return this.repairsService.getStatistics();
  }

  @Get('code/:code')
  async findByCode(@Param('code') code: string) {
    return this.repairsService.findByCode(code);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.repairsService.findOne(+id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: any, @Req() req) {
    return this.repairsService.update(+id, dto, req.user.id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.repairsService.remove(+id);
  }
}
