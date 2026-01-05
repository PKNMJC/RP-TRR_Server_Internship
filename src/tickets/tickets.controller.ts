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
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { TicketsService } from './tickets.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

@Controller('api/tickets')
export class TicketsController {
  constructor(private ticketsService: TicketsService) {}

  @Post()
  @UseInterceptors(FilesInterceptor('files', 5))
  create(
    @Request() req: any,
    @Body() createTicketDto: CreateTicketDto,
    @UploadedFiles() files?: any[],
  ) {
    return this.ticketsService.create(req.user.id, createTicketDto, files);
  }

  @Get()
  findAll(@Request() req: any) {
    // Show all tickets for IT/ADMIN, only user's tickets for regular users
    const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'IT';
    return this.ticketsService.findAll(isAdmin ? undefined : req.user.id);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    console.log(`[DEBUG] Fetching ticket with ID: ${id}`);
    try {
      const ticket = await this.ticketsService.findOne(+id);
      console.log(`[DEBUG] Ticket found:`, ticket ? 'Yes' : 'No');
      if (!ticket) {
        throw new NotFoundException(`Ticket with ID ${id} not found`);
      }
      console.log(`[DEBUG] Ticket ID:`, ticket.id, `Title:`, ticket.title);
      return ticket;
    } catch (error: any) {
      console.error(`[ERROR] Error fetching ticket ${id}:`, error.message);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to fetch ticket: ${error.message}`);
    }
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() updateTicketDto: UpdateTicketDto,
  ) {
    return this.ticketsService.update(+id, updateTicketDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.ticketsService.remove(+id);
  }
}
