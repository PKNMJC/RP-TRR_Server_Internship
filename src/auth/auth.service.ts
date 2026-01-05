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
    console.log('[LINE Auth] Processing callback with code:', code.substring(0, 10) + '...');
    
    if (!code) {
      console.error('[LINE Auth] No authorization code provided');
      throw new BadRequestException('Authorization code is required');
    }

    try {
      // Exchange authorization code for access token
      console.log('[LINE Auth] Step 1: Exchanging authorization code');
      const lineAccessToken = await this.exchangeLineCode(code);

      if (!lineAccessToken) {
        console.error('[LINE Auth] Failed to get access token');
        throw new UnauthorizedException('Failed to exchange LINE authorization code');
      }

      console.log('[LINE Auth] Step 2: Getting LINE user ID');
      // Get LINE user ID from the access token
      const lineUserId = await this.getLineUserId(lineAccessToken);

      if (!lineUserId) {
        console.error('[LINE Auth] Failed to get LINE user ID');
        throw new UnauthorizedException('Failed to get LINE user ID');
      }

      console.log('[LINE Auth] Step 3: Checking if user exists', { lineUserId });

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
        console.log('[LINE Auth] Step 4a: Creating new user');
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
        console.log('[LINE Auth] New user created', { userId: user.id });
      } else {
        console.log('[LINE Auth] Step 4b: Existing user found', { userId: user.id });
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

      console.log('[LINE Auth] Step 5: Generating JWT token', { userId: user.id, role: user.role });

      const payload = {
        sub: user.id,
        role: user.role,
      };

      const result = {
        access_token: this.jwtService.sign(payload),
        userId: user.id,
        role: user.role,
        message: 'LOGIN success via LINE',
      };

      console.log('[LINE Auth] Authentication successful', { userId: user.id, role: user.role });
      return result;
    } catch (error: any) {
      console.error('[LINE Auth] Callback error:', error.message);
      throw error;
    }
  }

  private async exchangeLineCode(code: string): Promise<string> {
    try {
      const redirectUri = process.env.LINE_REDIRECT_URI || 'https://rp-trr-client-internship.vercel.app/callback';
      const clientId = process.env.LINE_CHANNEL_ID || '';
      const clientSecret = process.env.LINE_CHANNEL_SECRET || '';

      if (!clientId || !clientSecret) {
        console.error('LINE environment variables not set:', { 
          clientId: !!clientId, 
          clientSecret: !!clientSecret 
        });
        throw new Error('LINE credentials not configured');
      }

      console.log('[LINE Auth] Exchanging authorization code for access token', {
        code: code.substring(0, 10) + '...', // Only show first 10 chars for security
        redirectUri,
        clientId,
      });

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      });

      console.log('[LINE Auth] Token request parameters:', {
        grant_type: 'authorization_code',
        code: code.substring(0, 10) + '...',
        redirect_uri: redirectUri,
        client_id: clientId,
      });

      const response = await fetch('https://api.line.me/oauth2/v2.1/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenParams.toString(),
      });

      const responseData = await response.json();

      if (!response.ok) {
        console.error('[LINE Auth] Token exchange failed with status:', response.status);
        console.error('[LINE Auth] Error response:', responseData);
        
        // Provide helpful error message
        let errorMessage = responseData.error || 'Unknown error';
        if (responseData.error === 'invalid_grant') {
          if (responseData.error_description?.includes('redirect_uri')) {
            errorMessage = `redirect_uri does not match. Registered redirect_uri in LINE Console must be: "${redirectUri}"`;
          }
        }
        
        throw new Error(`LINE API error: ${errorMessage} (${responseData.error_description || 'no description'})`);
      }

      console.log('[LINE Auth] Token exchange successful, received access token');
      return responseData.access_token;
    } catch (error: any) {
      console.error('[LINE Auth] Error exchanging LINE code:', error.message);
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
