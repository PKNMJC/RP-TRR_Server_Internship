import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getAllUsers(page: number = 1, limit: number = 10, roles?: string) {
    const skip = (page - 1) * limit;
    
    const where: any = {};
    if (roles) {
      const rolesArray = roles.split(',').map(r => r.trim());
      where.role = { in: rolesArray };
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          department: true,
          phoneNumber: true,
          lineId: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              tickets: true,
              assigned: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getITStaff() {
    return this.prisma.user.findMany({
      where: {
        role: {
          in: ['IT', 'ADMIN']
        }
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        phoneNumber: true,
        lineId: true
      },
      orderBy: {
        name: 'asc'
      }
    });
  }

  async getUserById(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        password: true,
        role: true,
        department: true,
        phoneNumber: true,
        lineId: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            tickets: true,
            assigned: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return user;
  }

  async updateUser(id: number, data: any) {
    // Check if user exists first
    const userExists = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!userExists) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const updateData: any = {};

    if (data.name) updateData.name = data.name;
    if (data.email) updateData.email = data.email;
    if (data.role) updateData.role = data.role;
    if (data.department) updateData.department = data.department;
    if (data.phoneNumber) updateData.phoneNumber = data.phoneNumber;
    if (data.lineId) updateData.lineId = data.lineId;
    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    return this.prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        phoneNumber: true,
        lineId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async deleteUser(id: number) {
    // Check if user exists first
    const userExists = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!userExists) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return this.prisma.user.delete({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });
  }

  async searchUsers(query: string) {
    return this.prisma.user.findMany({
      where: {
        OR: [
          { name: { contains: query } },
          { email: { contains: query } },
          { department: { contains: query } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        phoneNumber: true,
        lineId: true,
        createdAt: true,
        updatedAt: true,
      },
      take: 10,
    });
  }

  async createUser(data: any) {
    const hashedPassword = await bcrypt.hash(data.password, 10);

    return this.prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        password: hashedPassword,
        role: data.role || 'USER',
        department: data.department || '',
        phoneNumber: data.phoneNumber || '',
        lineId: data.lineId || '',
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        phoneNumber: true,
        lineId: true,
        createdAt: true,
      },
    });
  }

  async changePassword(id: number, newPassword: string) {
    // Check if user exists first
    const userExists = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!userExists) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    return this.prisma.user.update({
      where: { id },
      data: { password: hashedPassword },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        phoneNumber: true,
        lineId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Create a temporary user account from LINE User ID (for LIFF repairs)
   * Used when user submits repair via LIFF without being registered
   */
  async createUserFromLineId(lineUserId: string) {
    const timestamp = Date.now();
    const tempEmail = `line-${lineUserId}-${timestamp}@repair-system.local`;
    const tempName = `LINE User ${lineUserId.substring(1, 6)}`;

    // Create user with LINE OA Link
    const user = await this.prisma.user.create({
      data: {
        email: tempEmail,
        name: tempName,
        password: await bcrypt.hash(`temp_${lineUserId}`, 10), // Temporary password
        role: 'USER',
        lineOALink: {
          create: {
            lineUserId,
            status: 'VERIFIED',
            verificationToken: '',
            verificationExpiry: null,
          },
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
        password: true,
        role: true,
        department: true,
        phoneNumber: true,
        lineId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return user;
  }

  /**
   * Get or create a Guest user for anonymous repairs
   */
  async getOrCreateGuestUser() {
    const guestEmail = 'guest@repair-system.local';
    
    let guest = await this.prisma.user.findUnique({
      where: { email: guestEmail },
    });

    if (!guest) {
      const hashedPassword = await bcrypt.hash('guest_password', 10);
      guest = await this.prisma.user.create({
        data: {
          email: guestEmail,
          name: 'Guest User',
          password: hashedPassword,
          role: 'USER',
          department: 'General',
        },
      });
    }

    return guest;
  }
}

