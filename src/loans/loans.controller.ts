import { Controller, Get, Post, Body, Param, Put, Delete, Request, BadRequestException } from '@nestjs/common';
import { LoansService } from './loans.service';

@Controller('api/loans')
export class LoansController {
  constructor(private loansService: LoansService) {}

  @Post()
  async create(@Body() body: any, @Request() req: any) {
    try {
      const userId = req.user?.sub || req.user?.id;
      if (!userId) {
        throw new BadRequestException('User ID not found');
      }

      return await this.loansService.create({
        itemName: body.itemName,
        description: body.description,
        quantity: body.quantity,
        expectedReturnDate: body.expectedReturnDate,
        userId,
        borrowerName: body.borrowerName,
        borrowerDepartment: body.borrowerDepartment,
        borrowerPhone: body.borrowerPhone,
        borrowerLineId: body.borrowerLineId,
      });
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Get('admin/all')
  async findAllForAdmin(@Request() req: any) {
    try {
      const userId = req.user?.sub || req.user?.id;
      const userRole = req.user?.role;
      
      if (!userId) {
        throw new BadRequestException('User ID not found');
      }
      
      if (userRole !== 'ADMIN' && userRole !== 'IT') {
        throw new BadRequestException('Only admins can view all loans');
      }
      
      return await this.loansService.findAll(null);
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Get('check/overdue')
  async checkOverdue() {
    try {
      return await this.loansService.checkOverdue();
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Get()
  async findAll(@Request() req: any) {
    try {
      console.log('GET /api/loans - Full request.user:', req.user);
      console.log('GET /api/loans - req.user?.sub:', req.user?.sub);
      console.log('GET /api/loans - req.user?.id:', req.user?.id);
      
      const userId = req.user?.sub || req.user?.id;
      if (!userId) {
        console.error('GET /api/loans - No userId found in JWT');
        throw new BadRequestException('User ID not found');
      }
      
      console.log('GET /api/loans - Using userId:', userId);
      const loans = await this.loansService.findAll(userId);
      console.log('GET /api/loans - Found loans:', loans);
      return loans;
    } catch (error: any) {
      console.error('GET /api/loans - Error:', error);
      throw new BadRequestException(error.message);
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    try {
      return await this.loansService.findOne(parseInt(id));
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    try {
      console.log(`PUT /api/loans/${id} - Received body:`, body);
      
      const result = await this.loansService.update(parseInt(id), {
        status: body.status,
        returnDate: body.returnDate,
        itemName: body.itemName,
        description: body.description,
        quantity: body.quantity,
        expectedReturnDate: body.expectedReturnDate,
        borrowerName: body.borrowerName,
        borrowerDepartment: body.borrowerDepartment,
        borrowerPhone: body.borrowerPhone,
        borrowerLineId: body.borrowerLineId,
      });
      
      console.log(`PUT /api/loans/${id} - Update successful:`, result);
      return result;
    } catch (error: any) {
      console.error(`PUT /api/loans/${id} - Error:`, error);
      throw new BadRequestException(error.message);
    }
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    try {
      return await this.loansService.delete(parseInt(id));
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }
}
