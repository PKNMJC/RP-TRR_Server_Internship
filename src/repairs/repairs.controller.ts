import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RepairsService } from './repairs.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RepairTicketStatus, UrgencyLevel, Role } from '@prisma/client';

@Controller('repairs')
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
}
