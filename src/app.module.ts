import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { TicketsModule } from './tickets/tickets.module';
import { NotificationModule } from './notification/notification.module';
import { UsersModule } from './users/users.module';
import { LoansModule } from './loans/loans.module';
import { LineOAModule } from './line-oa/line-oa.module';
import { RepairsModule } from './repairs/repairs.module';
import { JwtAuthGuard } from './auth/jwt.guard';

@Module({
  imports: [AuthModule, TicketsModule, NotificationModule, UsersModule, LoansModule, LineOAModule, RepairsModule],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
