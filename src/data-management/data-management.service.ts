import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DataTypeInfo } from './dto/clear-data.dto';
import * as ExcelJS from 'exceljs';

export type DataType = 'repairs' | 'tickets' | 'loans' | 'notifications' | 'stock' | 'departments';

@Injectable()
export class DataManagementService {
  private readonly logger = new Logger(DataManagementService.name);

  constructor(private prisma: PrismaService) {}

  private readonly dataTypeDefinitions: Record<DataType, Omit<DataTypeInfo, 'count'>> = {
    repairs: {
      key: 'repairs',
      label: 'การแจ้งซ่อม',
      icon: '🔧',
      description: 'ข้อมูลการแจ้งซ่อมทั้งหมด รวมถึง logs และ attachments',
    },
    tickets: {
      key: 'tickets',
      label: 'Tickets',
      icon: '🎫',
      description: 'ระบบ Ticket เดิม รวมถึง logs และ attachments',
    },
    loans: {
      key: 'loans',
      label: 'การยืม',
      icon: '📦',
      description: 'ข้อมูลการยืมอุปกรณ์ทั้งหมด',
    },
    notifications: {
      key: 'notifications',
      label: 'การแจ้งเตือน',
      icon: '🔔',
      description: 'การแจ้งเตือนทั้งหมด รวมถึง LINE notifications',
    },
    stock: {
      key: 'stock',
      label: 'สต็อก',
      icon: '📊',
      description: 'ข้อมูลสินค้าคงคลังทั้งหมด',
    },
    departments: {
      key: 'departments',
      label: 'แผนก',
      icon: '🏢',
      description: 'ข้อมูลแผนกทั้งหมด',
    },
  };

  async getDataTypes(): Promise<DataTypeInfo[]> {
    const counts = await this.getDataCounts();
    
    return Object.entries(this.dataTypeDefinitions).map(([key, def]) => ({
      ...def,
      count: counts[key as DataType] || 0,
    }));
  }

  private async getDataCounts(): Promise<Record<DataType, number>> {
    const [repairs, tickets, loans, notifications, lineNotifications, stock, departments] = await Promise.all([
      this.prisma.repairTicket.count(),
      this.prisma.ticket.count(),
      this.prisma.loan.count(),
      this.prisma.notification.count(),
      this.prisma.lineNotification.count(),
      this.prisma.stockItem.count(),
      this.prisma.department.count(),
    ]);

    return {
      repairs,
      tickets,
      loans,
      notifications: notifications + lineNotifications,
      stock,
      departments,
    };
  }

  async exportToExcel(types: DataType[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TRR System';
    workbook.created = new Date();

    for (const type of types) {
      await this.addSheetForType(workbook, type);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private async addSheetForType(workbook: ExcelJS.Workbook, type: DataType) {
    switch (type) {
      case 'repairs':
        await this.addRepairsSheet(workbook);
        break;
      case 'tickets':
        await this.addTicketsSheet(workbook);
        break;
      case 'loans':
        await this.addLoansSheet(workbook);
        break;
      case 'notifications':
        await this.addNotificationsSheet(workbook);
        break;
      case 'stock':
        await this.addStockSheet(workbook);
        break;
      case 'departments':
        await this.addDepartmentsSheet(workbook);
        break;
    }
  }

  private async addRepairsSheet(workbook: ExcelJS.Workbook) {
    const sheet = workbook.addWorksheet('การแจ้งซ่อม');
    const repairs = await this.prisma.repairTicket.findMany({
      include: {
        user: { select: { name: true, email: true } },
        assignees: { include: { user: { select: { name: true } } } },
      },
    });

    sheet.columns = [
      { header: 'รหัส', key: 'ticketCode', width: 15 },
      { header: 'ชื่อปัญหา', key: 'problemTitle', width: 30 },
      { header: 'หมวดหมู่', key: 'problemCategory', width: 15 },
      { header: 'สถานที่', key: 'location', width: 20 },
      { header: 'ผู้แจ้ง', key: 'reporterName', width: 20 },
      { header: 'โทรศัพท์', key: 'reporterPhone', width: 15 },
      { header: 'สถานะ', key: 'status', width: 15 },
      { header: 'ความเร่งด่วน', key: 'urgency', width: 12 },
      { header: 'ผู้รับผิดชอบ', key: 'assignees', width: 30 },
      { header: 'วันที่สร้าง', key: 'createdAt', width: 20 },
    ];

    this.styleHeaderRow(sheet);

    repairs.forEach(repair => {
      sheet.addRow({
        ticketCode: repair.ticketCode,
        problemTitle: repair.problemTitle,
        problemCategory: repair.problemCategory,
        location: repair.location,
        reporterName: repair.reporterName,
        reporterPhone: repair.reporterPhone || '-',
        status: repair.status,
        urgency: repair.urgency,
        assignees: repair.assignees.map(a => a.user.name).join(', ') || '-',
        createdAt: repair.createdAt.toISOString(),
      });
    });
  }

  private async addTicketsSheet(workbook: ExcelJS.Workbook) {
    const sheet = workbook.addWorksheet('Tickets');
    const tickets = await this.prisma.ticket.findMany({
      include: {
        user: { select: { name: true } },
        assignee: { select: { name: true } },
      },
    });

    sheet.columns = [
      { header: 'รหัส', key: 'ticketCode', width: 15 },
      { header: 'หัวข้อ', key: 'title', width: 30 },
      { header: 'คำอธิบาย', key: 'description', width: 40 },
      { header: 'หมวดหมู่', key: 'category', width: 15 },
      { header: 'สถานที่', key: 'location', width: 20 },
      { header: 'สถานะ', key: 'status', width: 12 },
      { header: 'ความสำคัญ', key: 'priority', width: 12 },
      { header: 'ผู้แจ้ง', key: 'user', width: 20 },
      { header: 'ผู้รับผิดชอบ', key: 'assignee', width: 20 },
      { header: 'วันที่สร้าง', key: 'createdAt', width: 20 },
    ];

    this.styleHeaderRow(sheet);

    tickets.forEach(ticket => {
      sheet.addRow({
        ticketCode: ticket.ticketCode,
        title: ticket.title,
        description: ticket.description,
        category: ticket.category,
        location: ticket.location,
        status: ticket.status,
        priority: ticket.priority,
        user: ticket.user?.name || ticket.guestName || '-',
        assignee: ticket.assignee?.name || '-',
        createdAt: ticket.createdAt.toISOString(),
      });
    });
  }

  private async addLoansSheet(workbook: ExcelJS.Workbook) {
    const sheet = workbook.addWorksheet('การยืม');
    const loans = await this.prisma.loan.findMany({
      include: { borrowedBy: { select: { name: true } } },
    });

    sheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'รายการ', key: 'itemName', width: 30 },
      { header: 'จำนวน', key: 'quantity', width: 10 },
      { header: 'ผู้ยืม', key: 'borrower', width: 20 },
      { header: 'แผนก', key: 'department', width: 20 },
      { header: 'โทรศัพท์', key: 'phone', width: 15 },
      { header: 'วันที่ยืม', key: 'borrowDate', width: 15 },
      { header: 'กำหนดคืน', key: 'expectedReturn', width: 15 },
      { header: 'วันที่คืน', key: 'returnDate', width: 15 },
      { header: 'สถานะ', key: 'status', width: 12 },
    ];

    this.styleHeaderRow(sheet);

    loans.forEach(loan => {
      sheet.addRow({
        id: loan.id,
        itemName: loan.itemName,
        quantity: loan.quantity,
        borrower: loan.borrowerName || loan.borrowedBy.name,
        department: loan.borrowerDepartment || '-',
        phone: loan.borrowerPhone || '-',
        borrowDate: loan.borrowDate.toISOString().split('T')[0],
        expectedReturn: loan.expectedReturnDate.toISOString().split('T')[0],
        returnDate: loan.returnDate?.toISOString().split('T')[0] || '-',
        status: loan.status,
      });
    });
  }

  private async addNotificationsSheet(workbook: ExcelJS.Workbook) {
    const sheet = workbook.addWorksheet('การแจ้งเตือน');
    const notifications = await this.prisma.notification.findMany({
      include: { user: { select: { name: true } } },
    });

    sheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'ผู้รับ', key: 'user', width: 20 },
      { header: 'ประเภท', key: 'type', width: 20 },
      { header: 'หัวข้อ', key: 'title', width: 30 },
      { header: 'ข้อความ', key: 'message', width: 50 },
      { header: 'สถานะ', key: 'status', width: 12 },
      { header: 'วันที่สร้าง', key: 'createdAt', width: 20 },
    ];

    this.styleHeaderRow(sheet);

    notifications.forEach(n => {
      sheet.addRow({
        id: n.id,
        user: n.user.name,
        type: n.type,
        title: n.title,
        message: n.message,
        status: n.status,
        createdAt: n.createdAt.toISOString(),
      });
    });
  }

  private async addStockSheet(workbook: ExcelJS.Workbook) {
    const sheet = workbook.addWorksheet('สต็อก');
    const items = await this.prisma.stockItem.findMany();

    sheet.columns = [
      { header: 'รหัส', key: 'code', width: 15 },
      { header: 'ชื่อ', key: 'name', width: 30 },
      { header: 'จำนวน', key: 'quantity', width: 10 },
      { header: 'หมวดหมู่', key: 'category', width: 20 },
      { header: 'สถานที่เก็บ', key: 'location', width: 20 },
      { header: 'วันที่สร้าง', key: 'createdAt', width: 20 },
    ];

    this.styleHeaderRow(sheet);

    items.forEach(item => {
      sheet.addRow({
        code: item.code,
        name: item.name,
        quantity: item.quantity,
        category: item.category || '-',
        location: item.location || '-',
        createdAt: item.createdAt.toISOString(),
      });
    });
  }

  private async addDepartmentsSheet(workbook: ExcelJS.Workbook) {
    const sheet = workbook.addWorksheet('แผนก');
    const departments = await this.prisma.department.findMany();

    sheet.columns = [
      { header: 'รหัส', key: 'code', width: 15 },
      { header: 'ชื่อ', key: 'name', width: 30 },
      { header: 'คำอธิบาย', key: 'description', width: 40 },
      { header: 'สถานที่', key: 'location', width: 20 },
      { header: 'อีเมล', key: 'contactEmail', width: 25 },
      { header: 'โทรศัพท์', key: 'contactPhone', width: 15 },
      { header: 'หัวหน้า', key: 'headName', width: 20 },
    ];

    this.styleHeaderRow(sheet);

    departments.forEach(dept => {
      sheet.addRow({
        code: dept.code,
        name: dept.name,
        description: dept.description || '-',
        location: dept.location || '-',
        contactEmail: dept.contactEmail || '-',
        contactPhone: dept.contactPhone || '-',
        headName: dept.headName || '-',
      });
    });
  }

  private styleHeaderRow(sheet: ExcelJS.Worksheet) {
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4F46E5' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;
  }

  async clearData(types: DataType[]): Promise<{ success: boolean; deleted: Record<string, number> }> {
    const deleted: Record<string, number> = {};

    await this.prisma.$transaction(async (tx) => {
      for (const type of types) {
        switch (type) {
          case 'repairs':
            // Delete in order due to relations
            const repairLogs = await tx.repairTicketLog.deleteMany();
            const repairAssignees = await tx.repairTicketAssignee.deleteMany();
            const repairAttachments = await tx.repairAttachment.deleteMany();
            const repairs = await tx.repairTicket.deleteMany();
            deleted['repairs'] = repairs.count;
            deleted['repairLogs'] = repairLogs.count;
            deleted['repairAssignees'] = repairAssignees.count;
            deleted['repairAttachments'] = repairAttachments.count;
            break;

          case 'tickets':
            const ticketLogs = await tx.ticketLog.deleteMany();
            const attachments = await tx.attachment.deleteMany();
            const tickets = await tx.ticket.deleteMany();
            deleted['tickets'] = tickets.count;
            deleted['ticketLogs'] = ticketLogs.count;
            deleted['attachments'] = attachments.count;
            break;

          case 'loans':
            const loans = await tx.loan.deleteMany();
            deleted['loans'] = loans.count;
            break;

          case 'notifications':
            const notifications = await tx.notification.deleteMany();
            const lineNotifications = await tx.lineNotification.deleteMany();
            deleted['notifications'] = notifications.count;
            deleted['lineNotifications'] = lineNotifications.count;
            break;

          case 'stock':
            const stock = await tx.stockItem.deleteMany();
            deleted['stock'] = stock.count;
            break;

          case 'departments':
            const departments = await tx.department.deleteMany();
            deleted['departments'] = departments.count;
            break;
        }
      }
    });

    this.logger.warn(`Data cleared by admin: ${JSON.stringify(deleted)}`);
    return { success: true, deleted };
  }
}
