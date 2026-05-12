import { Controller, Post, Get, UseGuards, Request } from '@nestjs/common';
import { BreakService } from './break.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('break')
@UseGuards(JwtAuthGuard)
export class BreakController {
  constructor(private breakService: BreakService) {}

  @Post('start')
  async startFlexibleBreak(@Request() req) {
    return this.breakService.startFlexibleBreak(req.user.id);
  }

  @Post('end')
  async endFlexibleBreak(@Request() req) {
    return this.breakService.endFlexibleBreak(req.user.id);
  }

  @Get('status')
  async getFlexibleBreakStatus(@Request() req) {
    return this.breakService.getFlexibleBreakStatus(req.user.id);
  }

  @Get('history/today')
  async getTodayBreakHistory(@Request() req) {
    return this.breakService.getTodayBreakHistory(req.user.id);
  }
}
