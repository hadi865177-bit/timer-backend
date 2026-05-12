import { Module } from '@nestjs/common';
import { BreakController } from './break.controller';
import { BreakService } from './break.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BreakController],
  providers: [BreakService],
  exports: [BreakService],
})
export class BreakModule {}
