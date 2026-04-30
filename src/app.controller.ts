import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import * as path from 'path';

@Controller('app')
export class AppController {
  @Get('health')
  getHealth() {
    const memUsage = process.memoryUsage();
    const uptime = process.uptime();
    
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memory: {
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      },
      nodeVersion: process.version,
    };
  }

  @Get('version')
  getVersion() {
    return {
      version: '1.0.0',
      downloadUrl: 'http://3.144.130.126/downloads/desktop-app',
      releaseNotes: 'Production build - Connected to production backend',
      mandatory: false,
    };
  }

  @Get('downloads/desktop-app')
  downloadDesktopApp(@Res() res: Response) {
    const filePath = '/home/ec2-user/backend/public/downloads/HRMS-Desktop-App-Setup.exe';
    res.download(filePath, 'HRMS-Desktop-App-Setup.exe');
  }
}
