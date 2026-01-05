import { Controller, Post, Body, Get, Patch, Request, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @Public()
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Public()
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('line-callback')
  @Public()
  async lineCallback(@Body() dto: { code: string; state?: string }) {
    return this.authService.lineCallback(dto.code, dto.state);
  }

  @Get('profile')
  getProfile(@Request() req) {
    console.log('Getting profile for user:', req.user);
    if (!req.user || !req.user.id) {
      throw new BadRequestException('User information not found in request');
    }
    return this.authService.getProfile(req.user.id);
  }

  @Patch('profile')
  updateProfile(
    @Request() req,
    @Body() data: { name?: string; department?: string; phoneNumber?: string; lineId?: string },
  ) {
    return this.authService.updateProfile(req.user.id, data);
  }
}
