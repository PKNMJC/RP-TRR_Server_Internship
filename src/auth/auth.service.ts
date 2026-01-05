import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const hash = await bcrypt.hash(dto.password, 10);

    try {
      const user = await this.prisma.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          password: hash,
          role: 'USER', // Always set to USER - admins manage roles
          department: dto.department,
          phoneNumber: dto.phoneNumber,
          lineId: dto.lineId,
        },
      });

      return {
        message: 'Register success',
        userId: user.id,
        role: user.role,
      };
    } catch (error: any) {
      // Handle duplicate email error
      if (error.code === 'P2002' && error.meta?.target?.includes('email')) {
        throw new BadRequestException('Email already exists');
      }
      throw error;
    }
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Email or password incorrect');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Email or password incorrect');
    }

    const payload = {
      sub: user.id,
      role: user.role,
    };

    return {
      access_token: this.jwtService.sign(payload),
      userId: user.id,
      role: user.role,
      message: 'Login success',
    };
  }

  async getProfile(userId: number) {
    try {
      console.log('Fetching profile for userId:', userId);
      
      if (!userId || typeof userId !== 'number') {
        throw new BadRequestException('Invalid user ID');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
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

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      console.log('Profile found:', user.id);
      return user;
    } catch (error: any) {
      console.error('Error in getProfile:', error.message);
      throw error;
    }
  }

  async updateProfile(userId: number, data: { name?: string; department?: string; phoneNumber?: string; lineId?: string }) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.department && { department: data.department }),
        ...(data.phoneNumber && { phoneNumber: data.phoneNumber }),
        ...(data.lineId && { lineId: data.lineId }),
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

    return user;
  }
}
