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

  async lineCallback(code: string, state?: string) {
    if (!code) {
      throw new BadRequestException('Authorization code is required');
    }

    try {
      // Exchange authorization code for access token
      const lineAccessToken = await this.exchangeLineCode(code);

      if (!lineAccessToken) {
        throw new UnauthorizedException('Failed to exchange LINE authorization code');
      }

    // Get LINE user ID from the access token
    const lineUserId = await this.getLineUserId(lineAccessToken);

    if (!lineUserId) {
      throw new UnauthorizedException('Failed to get LINE user ID');
    }

    // Check if user with this LINE ID exists
    let user = await this.prisma.user.findFirst({
      where: {
        lineOALink: {
          lineUserId: lineUserId,
        },
      },
    });

    // If user doesn't exist, create a new user
    if (!user) {
      // Get LINE user profile
      const lineProfile = await this.getLineUserProfile(lineAccessToken);

      user = await this.prisma.user.create({
        data: {
          name: lineProfile.displayName || 'LINE User',
          email: `line_${lineUserId}@line.com`,
          password: await bcrypt.hash(Math.random().toString(36), 10), // Random password for LINE users
          role: 'USER',
          lineId: lineUserId,
          lineOALink: {
            create: {
              lineUserId: lineUserId,
              status: 'VERIFIED',
            },
          },
        },
      });
    } else {
      // Update LINE user ID if not already set
      if (!user.lineId) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            lineId: lineUserId,
          },
        });
      }
    }

    const payload = {
      sub: user.id,
      role: user.role,
    };

    return {
      access_token: this.jwtService.sign(payload),
      userId: user.id,
      role: user.role,
      message: 'LOGIN success via LINE',
    };
    } catch (error: any) {
      console.error('LINE callback error:', error);
      throw error;
    }
  }
  }

  private async exchangeLineCode(code: string): Promise<string> {
    try {
      const redirectUri = process.env.LINE_REDIRECT_URI || 'https://rp-trr-server-internship.vercel.app/callback';
      const clientId = process.env.LINE_CHANNEL_ID || '';
      const clientSecret = process.env.LINE_CHANNEL_SECRET || '';

      if (!clientId || !clientSecret) {
        console.error('LINE environment variables not set:', { 
          clientId: !!clientId, 
          clientSecret: !!clientSecret 
        });
        throw new Error('LINE credentials not configured');
      }

      console.log('Exchanging LINE code:', { code, redirectUri, clientId });

      const response = await fetch('https://api.line.me/oauth2/v2.1/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });

      const responseData = await response.json();

      if (!response.ok) {
        console.error('LINE token exchange failed:', responseData);
        throw new Error(`LINE API error: ${responseData.error_description || responseData.error || 'Unknown error'}`);
      }

      return responseData.access_token;
    } catch (error: any) {
      console.error('Error exchanging LINE code:', error.message);
      throw new UnauthorizedException(`Failed to authenticate with LINE: ${error.message}`);
    }
  }

  private async getLineUserId(accessToken: string): Promise<string | null> {
    try {
      const response = await fetch('https://api.line.me/v2/oauth/tokeninfo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          access_token: accessToken,
        }).toString(),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      return data.user_id || null;
    } catch (error) {
      console.error('Error getting LINE user ID:', error);
      return null;
    }
  }

  private async getLineUserProfile(accessToken: string): Promise<any> {
    try {
      const response = await fetch('https://api.line.me/v2/profile', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to get LINE profile');
      }

      return await response.json();
    } catch (error) {
      console.error('Error getting LINE profile:', error);
      return { displayName: 'LINE User' };
    }
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
