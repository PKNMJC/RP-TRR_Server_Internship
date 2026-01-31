import { Controller, Get, Post, Body, Res, UseGuards, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { DataManagementService, DataType } from './data-management.service';
import { ClearDataDto, ExportDataDto } from './dto/clear-data.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';

@Controller('data-management')
@UseGuards(RolesGuard)
@Roles(Role.ADMIN)
export class DataManagementController {
  constructor(private readonly dataManagementService: DataManagementService) {}

  @Get('types')
  async getDataTypes() {
    return this.dataManagementService.getDataTypes();
  }

  @Post('export')
  async exportData(@Body() dto: ExportDataDto, @Res() res: Response) {
    const buffer = await this.dataManagementService.exportToExcel(dto.types as DataType[]);
    
    const filename = `data-export-${new Date().toISOString().split('T')[0]}.xlsx`;
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    
    return res.status(HttpStatus.OK).send(buffer);
  }

  @Post('clear')
  async clearData(@Body() dto: ClearDataDto, @Res() res: Response) {
    // If exportFirst is true, first export then clear
    if (dto.exportFirst) {
      const buffer = await this.dataManagementService.exportToExcel(dto.types as DataType[]);
      await this.dataManagementService.clearData(dto.types as DataType[]);
      
      const filename = `data-backup-${new Date().toISOString().split('T')[0]}.xlsx`;
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      
      return res.status(HttpStatus.OK).send(buffer);
    }
    
    // Just clear without export
    const result = await this.dataManagementService.clearData(dto.types as DataType[]);
    return res.status(HttpStatus.OK).json(result);
  }
}
