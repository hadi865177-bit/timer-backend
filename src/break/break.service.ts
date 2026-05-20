import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'crypto';

@Injectable()
export class BreakService {
  private readonly MAX_BREAK_DURATION_SECONDS = 3600; // 1 hour (Production)

  constructor(private prisma: PrismaService) {}

  async startFlexibleBreak(userId: string) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Check if user already has an active break session
    const activeBreak = await this.prisma.break_sessions.findFirst({
      where: {
        user_id: userId,
        break_out_time: null,
      },
    });

    if (activeBreak) {
      throw new BadRequestException('You already have an active break session');
    }

    // Find the first check-in session of today to calculate the 2-hour restriction from the start of the day
    const firstSessionToday = await this.prisma.deviceSession.findFirst({
      where: {
        userId,
        startedAt: { gte: today },
      },
      orderBy: {
        startedAt: 'asc',
      },
    });

    if (!firstSessionToday) {
      throw new BadRequestException('You must check in first before starting a break.');
    }

    const twoHoursInMs = 2 * 60 * 60 * 1000; // 2 hours
    const timeElapsed = now.getTime() - firstSessionToday.startedAt.getTime();

    if (timeElapsed < twoHoursInMs) {
      const remainingMs = twoHoursInMs - timeElapsed;
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      throw new BadRequestException(`You can only take a break after 2 hours of check-in. Please wait ${remainingMinutes} more minute(s).`);
    }

    // Check if user already took a break today
    const todayBreak = await this.prisma.break_sessions.findFirst({
      where: {
        user_id: userId,
        break_in_time: { gte: today },
      },
    });

    if (todayBreak) {
      throw new BadRequestException('You have already taken a break today. Only one break per day is allowed.');
    }

    // Create new break session
    const breakSession = await this.prisma.break_sessions.create({
      data: {
        id: randomUUID(),
        user_id: userId,
        break_in_time: now,
        break_out_time: null,
        duration_seconds: null,
        is_auto_break_out: false,
        late_return_seconds: null,
      },
    });

    console.log(`🍽️ Break started for user ${userId} at ${now.toISOString()}`);

    // Schedule auto break-out after 1 hour
    setTimeout(async () => {
      await this.autoBreakOut(breakSession.id, userId);
    }, this.MAX_BREAK_DURATION_SECONDS * 1000);

    return {
      success: true,
      breakSessionId: breakSession.id,
      breakInTime: breakSession.break_in_time,
      maxDurationSeconds: this.MAX_BREAK_DURATION_SECONDS,
    };
  }

  async endFlexibleBreak(userId: string) {
    const activeBreak = await this.prisma.break_sessions.findFirst({
      where: {
        user_id: userId,
        break_out_time: null,
      },
    });

    if (!activeBreak) {
      throw new BadRequestException('No active break session found');
    }

    const now = new Date();
    const durationSeconds = Math.floor((now.getTime() - activeBreak.break_in_time.getTime()) / 1000);

    // Check if user is late (returned after 1 hour)
    let lateReturnSeconds = 0;
    if (durationSeconds > this.MAX_BREAK_DURATION_SECONDS) {
      lateReturnSeconds = durationSeconds - this.MAX_BREAK_DURATION_SECONDS;
      console.log(`⚠️ User ${userId} returned ${lateReturnSeconds}s late from break`);
    }

    // Update break session
    await this.prisma.break_sessions.update({
      where: { id: activeBreak.id },
      data: {
        break_out_time: now,
        duration_seconds: durationSeconds,
        late_return_seconds: lateReturnSeconds > 0 ? lateReturnSeconds : null,
        is_auto_break_out: false,
      },
    });

    console.log(`✅ Break ended for user ${userId} - Duration: ${durationSeconds}s, Late: ${lateReturnSeconds}s`);

    return {
      success: true,
      breakInTime: activeBreak.break_in_time,
      breakOutTime: now,
      durationSeconds,
      lateReturnSeconds,
      wasLate: lateReturnSeconds > 0,
    };
  }

  async getFlexibleBreakStatus(userId: string) {
    const now = new Date();
    const activeBreak = await this.prisma.break_sessions.findFirst({
      where: {
        user_id: userId,
        break_out_time: null,
      },
    });

    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Find the first check-in session of today to check break eligibility
    const firstSessionToday = await this.prisma.deviceSession.findFirst({
      where: {
        userId,
        startedAt: { gte: today },
      },
      orderBy: {
        startedAt: 'asc',
      },
    });

    let canTakeBreak = true;
    let breakAvailableInSeconds = 0;

    if (firstSessionToday) {
      const twoHoursInMs = 2 * 60 * 60 * 1000;
      const timeElapsed = now.getTime() - firstSessionToday.startedAt.getTime();
      if (timeElapsed < twoHoursInMs) {
        canTakeBreak = false;
        breakAvailableInSeconds = Math.max(0, Math.ceil((twoHoursInMs - timeElapsed) / 1000));
      }
    } else {
      canTakeBreak = false;
      breakAvailableInSeconds = -1; // Not checked in today
    }

    if (!activeBreak) {
      return {
        inBreak: false,
        elapsedSeconds: 0,
        remainingSeconds: 0,
        canTakeBreak,
        breakAvailableInSeconds,
      };
    }

    const elapsedSeconds = Math.floor((now.getTime() - activeBreak.break_in_time.getTime()) / 1000);
    
    // Check if break has exceeded max duration (Auto Break-out)
    if (elapsedSeconds >= this.MAX_BREAK_DURATION_SECONDS) {
      console.log(`⏰ Break exceeded limit (${elapsedSeconds}s > ${this.MAX_BREAK_DURATION_SECONDS}s). Triggering auto break-out...`);
      await this.autoBreakOut(activeBreak.id, userId);
      return {
        inBreak: false,
        elapsedSeconds: 0,
        remainingSeconds: 0,
        wasAutoStopped: true,
        canTakeBreak: false,
        breakAvailableInSeconds: -1,
      };
    }

    const remainingSeconds = Math.max(0, this.MAX_BREAK_DURATION_SECONDS - elapsedSeconds);

    return {
      inBreak: true,
      elapsedSeconds,
      remainingSeconds,
      breakInTime: activeBreak.break_in_time,
      maxDurationSeconds: this.MAX_BREAK_DURATION_SECONDS,
      canTakeBreak: false,
      breakAvailableInSeconds: 0,
    };
  }

  private async autoBreakOut(breakSessionId: string, userId: string) {
    try {
      // Check if break is still active
      const breakSession = await this.prisma.break_sessions.findUnique({
        where: { id: breakSessionId },
      });

      if (!breakSession || breakSession.break_out_time !== null) {
        console.log(`⏭️ Break session ${breakSessionId} already ended, skipping auto break-out`);
        return;
      }

      const now = new Date();
      const durationSeconds = Math.floor((now.getTime() - breakSession.break_in_time.getTime()) / 1000);

      // Auto break-out after 1 hour
      await this.prisma.break_sessions.update({
        where: { id: breakSessionId },
        data: {
          break_out_time: now,
          duration_seconds: durationSeconds,
          is_auto_break_out: true,
          late_return_seconds: null, // No late time since it's auto break-out
        },
      });

      console.log(`⏰ Auto break-out for user ${userId} after ${durationSeconds}s`);
    } catch (error) {
      console.error(`❌ Auto break-out failed for session ${breakSessionId}:`, error);
    }
  }

  async getTodayBreakHistory(userId: string) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const breaks = await this.prisma.break_sessions.findMany({
      where: {
        user_id: userId,
        break_in_time: { gte: today },
      },
      orderBy: { break_in_time: 'desc' },
    });

    return breaks.map(b => ({
      id: b.id,
      breakInTime: b.break_in_time,
      breakOutTime: b.break_out_time,
      durationSeconds: b.duration_seconds,
      isAutoBreakOut: b.is_auto_break_out,
      lateReturnSeconds: b.late_return_seconds,
      wasLate: (b.late_return_seconds || 0) > 0,
    }));
  }
}
