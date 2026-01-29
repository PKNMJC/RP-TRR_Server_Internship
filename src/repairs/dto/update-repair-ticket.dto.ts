import { PartialType } from '@nestjs/mapped-types';
import { CreateRepairTicketDto } from './create-repair-ticket.dto';
import { IsOptional, IsEnum } from 'class-validator';
import { RepairTicketStatus } from '@prisma/client';

export class UpdateRepairTicketDto extends PartialType(CreateRepairTicketDto) {
  @IsOptional()
  @IsEnum(RepairTicketStatus)
  status?: RepairTicketStatus;

  @IsOptional()
  notes?: string;

  @IsOptional()
  scheduledAt?: Date;
}
