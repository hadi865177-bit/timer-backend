import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RollupService } from './rollup.service';
import { isWithinCheckinWindow, isWithinBreakWindow } from '../shared/utils';
import { randomUUID } from 'crypto';

interface ActivityBatchItem {
  capturedAt: string;
  mouseDelta: number;
  keyCount: number;
  activeSeconds?: number;
  deviceSessionId?: string;
}

@Injectable()
export class ActivityService {
  private pendingRollups = 0;
  private readonly MAX_PENDING_ROLLUPS = 10;

  constructor(
    private prisma: PrismaService,
    @Optional() @InjectQueue('activity-rollup') private rollupQueue: Queue,
    private rollupService: RollupService,
  ) {}

  async startSession(userId: string, deviceId: string, platform: string) {
    // Check if current time is within check-in window
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { 
        organization: { 
          include: { organization_work_policies: true } 
        },
        tracker_profiles: true,
      },
    });

    if (!user || !user.organization.organization_work_policies) {
      throw new BadRequestException('User or organization policy not found');
    }

    const policy = user.organization.organization_work_policies;
    const trackerProfile = user.tracker_profiles;
    
    const formatTime = (time: Date | null) => {
      if (!time) return null;
      const hours = time.getUTCHours().toString().padStart(2, '0');
      const minutes = time.getUTCMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    };
    
    const rules = {
      timezone: user.organization.timezone,
      checkinWindow: {
        start: trackerProfile?.custom_schedule_start ? formatTime(trackerProfile.custom_schedule_start) : formatTime(policy.shift_start) || '09:00',
        end: trackerProfile?.custom_schedule_end ? formatTime(trackerProfile.custom_schedule_end) : formatTime(policy.shift_end) || '18:00',
      },
      breakWindow: {
        start: trackerProfile?.custom_break_start ? formatTime(trackerProfile.custom_break_start) : formatTime(policy.break_start) || '12:00',
        end: trackerProfile?.custom_break_end ? formatTime(trackerProfile.custom_break_end) : formatTime(policy.break_end) || '13:00',
      },
      idleThresholdSeconds: policy.idle_threshold_seconds,
    };

    const now = new Date();
    const isInCheckin = isWithinCheckinWindow(now, rules);
    
    if (!isInCheckin) {
      throw new BadRequestException(`Tracking can only be started during office hours (${rules.checkinWindow.start} - ${rules.checkinWindow.end})`);
    }

    const existingSessions = await this.prisma.deviceSession.findMany({
      where: { userId, deviceId, endedAt: null },
    });

    // Close unclosed sessions and queue rollup in background
    if (existingSessions.length > 0) {
      // Check if we can queue in background or need to process synchronously
      if (this.pendingRollups >= this.MAX_PENDING_ROLLUPS) {
        console.log(`⚠️ Too many pending rollups (${this.pendingRollups}), processing synchronously`);
        // Process synchronously to prevent memory spike
        for (const oldSession of existingSessions) {
          console.log(`⚠️ Found unclosed session ${oldSession.id}, closing and processing...`);
          
          await this.prisma.deviceSession.update({
            where: { id: oldSession.id },
            data: { endedAt: new Date() },
          });

          const from = oldSession.startedAt;
          const to = new Date();
          
          if (this.rollupQueue) {
            try {
              // Round to minutes for stable job ID deduplication
              const roundedFrom = Math.floor(from.getTime() / 60000) * 60000;
              const roundedTo = Math.floor(to.getTime() / 60000) * 60000;
              const jobId = `rollup-${oldSession.userId}-${roundedFrom}-${roundedTo}`;
              
              await this.rollupQueue.add('rollup-user', { userId: oldSession.userId, from, to }, { 
                jobId,
                removeOnComplete: true,
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 }
              });
              console.log(`🔄 Queued rollup for unclosed session ${oldSession.id} (Job ID: ${jobId})`);
            } catch (error) {
              console.log(`⚠️ Redis unavailable, running rollup directly for unclosed session`);
              await this.rollupService.rollupUserActivity(oldSession.userId, from, to);
            }
          } else {
            await this.rollupService.rollupUserActivity(oldSession.userId, from, to);
          }
        }
      } else {
        // Queue in background with backpressure control
        this.pendingRollups++;
        setImmediate(async () => {
          try {
            for (const oldSession of existingSessions) {
              console.log(`⚠️ Found unclosed session ${oldSession.id}, closing and processing...`);
              
              await this.prisma.deviceSession.update({
                where: { id: oldSession.id },
                data: { endedAt: new Date() },
              });

              const from = oldSession.startedAt;
              const to = new Date();
              
              if (this.rollupQueue) {
                try {
                  const roundedFrom = Math.floor(from.getTime() / 60000) * 60000;
                  const roundedTo = Math.floor(to.getTime() / 60000) * 60000;
                  const jobId = `rollup-${oldSession.userId}-${roundedFrom}-${roundedTo}`;

                  await this.rollupQueue.add('rollup-user', { userId: oldSession.userId, from, to }, { 
                    jobId,
                    removeOnComplete: true,
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 1000 }
                  });
                  console.log(`🔄 Queued rollup for unclosed session ${oldSession.id} (Job ID: ${jobId})`);
                } catch (error) {
                  console.log(`⚠️ Redis unavailable, running rollup directly for unclosed session`);
                  await this.rollupService.rollupUserActivity(oldSession.userId, from, to);
                }
              } else {
                await this.rollupService.rollupUserActivity(oldSession.userId, from, to);
              }
            }
          } catch (error) {
            console.error('Background rollup error:', error);
          } finally {
            this.pendingRollups--;
          }
        });
      }
    }

    const session = await this.prisma.deviceSession.create({
      data: { 
        id: randomUUID(),
        userId, 
        deviceId, 
        platform, 
        startedAt: new Date() 
      },
    });

    console.log(`✅ Created new session ${session.id}`);
    return session;
  }

  async stopSession(sessionId: string) {
    const session = await this.prisma.deviceSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new BadRequestException('Session not found');
    }

    const updatedSession = await this.prisma.deviceSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date() },
    });

    const from = session.startedAt;
    const to = new Date();

    if (this.rollupQueue) {
      try {
        const roundedFrom = Math.floor(from.getTime() / 60000) * 60000;
        const roundedTo = Math.floor(to.getTime() / 60000) * 60000;
        const jobId = `rollup-${session.userId}-${roundedFrom}-${roundedTo}`;

        await this.rollupQueue.add('rollup-user', { userId: session.userId, from, to }, { 
          jobId,
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 }
        });
        console.log(`🔄 Queued final rollup for session ${sessionId} (Job ID: ${jobId})`);
      } catch (error) {
        console.log(`⚠️ Redis unavailable, running final rollup directly`);
        await this.rollupService.rollupUserActivity(session.userId, from, to);
      }
    } else {
      await this.rollupService.rollupUserActivity(session.userId, from, to);
    }

    return updatedSession;
  }

  async batchUpload(userId: string, samples: ActivityBatchItem[], projectId?: string) {
    console.log(`📥 Received batch upload: ${samples.length} samples from user ${userId}, project: ${projectId || 'None'}`);
    
    if (samples.length === 0) {
      return { inserted: 0 };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { 
        organization: { 
          include: { organization_work_policies: true } 
        },
        tracker_profiles: true,
      },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (!user.organization.organization_work_policies) {
      throw new BadRequestException('Organization work policy not configured');
    }

    const policy = user.organization.organization_work_policies;
    const trackerProfile = user.tracker_profiles;
    
    const formatTime = (time: Date | null) => {
      if (!time) return null;
      const hours = time.getUTCHours().toString().padStart(2, '0');
      const minutes = time.getUTCMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    };
    
    const rules = {
      timezone: user.organization.timezone,
      checkinWindow: {
        start: trackerProfile?.custom_schedule_start ? formatTime(trackerProfile.custom_schedule_start) : formatTime(policy.shift_start) || '09:00',
        end: trackerProfile?.custom_schedule_end ? formatTime(trackerProfile.custom_schedule_end) : formatTime(policy.shift_end) || '18:00',
      },
      breakWindow: (trackerProfile as any)?.is_flexible_break 
        ? { start: null, end: null } 
        : {
          start: trackerProfile?.custom_break_start ? formatTime(trackerProfile.custom_break_start) : formatTime(policy.break_start) || '12:00',
          end: trackerProfile?.custom_break_end ? formatTime(trackerProfile.custom_break_end) : formatTime(policy.break_end) || '13:00',
        },
      idleThresholdSeconds: policy.idle_threshold_seconds,
    };

    console.log(`⏰ [DEBUG] Rules for user ${userId}:`);
    console.log(`   - Timezone: ${rules.timezone}`);
    console.log(`   - Check-in: ${rules.checkinWindow.start} to ${rules.checkinWindow.end} (${trackerProfile?.custom_schedule_start ? 'CUSTOM' : 'ORG'})`);
    if ((trackerProfile as any)?.is_flexible_break) {
      console.log(`   - Break: IGNORED (Flexible Mode Enabled ✅)`);
    } else {
      console.log(`   - Break: ${rules.breakWindow.start} to ${rules.breakWindow.end} (${trackerProfile?.custom_break_start ? 'CUSTOM' : 'ORG'})`);
    }
    
    const validSamples = [];
    
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const timestamp = new Date(sample.capturedAt);
      
      const localTimeStr = new Intl.DateTimeFormat('en-US', {
        timeZone: rules.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(timestamp).replace('24:', '00:');
      
      const isInCheckin = isWithinCheckinWindow(timestamp, rules);
      const isInBreak = isWithinBreakWindow(timestamp, rules);
      
      if (index === 0 || index === samples.length - 1) {
        console.log(`🔍 [SAMPLE ${index}] Time: ${localTimeStr} | InCheckin: ${isInCheckin} | InBreak: ${isInBreak}`);
      }

      if (!isInCheckin) {
        continue;
      }

      if (isInBreak) {
        console.log(`🚫 [REJECTED] Sample at ${localTimeStr} rejected because it is in BREAK window (${rules.breakWindow.start}-${rules.breakWindow.end})`);
        continue;
      }

      validSamples.push(sample);
    }

    if (validSamples.length > 0) {
      const dataToInsert = validSamples.map((sample) => ({
        userId,
        capturedAt: new Date(sample.capturedAt),
        mouseDelta: sample.mouseDelta,
        keyCount: sample.keyCount,
        activeSeconds: sample.activeSeconds ?? null,
        deviceSessionId: sample.deviceSessionId || null,
      }));
      
      await this.prisma.activitySample.createMany({ data: dataToInsert });

      console.log(`✅ Inserted ${validSamples.length} samples into database`);

      const firstSampleTime = new Date(validSamples[0].capturedAt);
      const lastSampleTime = new Date(validSamples[validSamples.length - 1].capturedAt);
      
      // Get active session
      const activeSession = await this.prisma.deviceSession.findFirst({
        where: { userId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      
      // Find last processed TimeEntry
      const lastEntry = await this.prisma.timeEntry.findFirst({
        where: { userId, source: 'AUTO' },
        orderBy: { endedAt: 'desc' },
      });
      
      // Use 10-minute lookback to ensure idle threshold detection (5min threshold + buffer), bounded by session start
      let from: Date;
      if (lastEntry && activeSession) {
        const lookbackTime = new Date(lastEntry.endedAt.getTime() - 6 * 60 * 1000);
        from = lookbackTime > activeSession.startedAt ? lookbackTime : activeSession.startedAt;
        console.log(`🔄 Rollup from ${from.toISOString()} (6min lookback, bounded by session)`);
      } else if (activeSession) {
        from = activeSession.startedAt;
        console.log(`🔄 Rollup from session start: ${from.toISOString()}`);
      } else {
        from = new Date(firstSampleTime.getTime() - 6 * 60 * 1000);
        console.log(`🔄 Rollup from 6min before first sample: ${from.toISOString()}`);
      }
      
      const to = lastSampleTime;

      if (this.rollupQueue) {
        try {
          const roundedFrom = Math.floor(from.getTime() / 60000) * 60000;
          const roundedTo = Math.floor(to.getTime() / 60000) * 60000;
          const jobId = `rollup-${userId}-${roundedFrom}-${roundedTo}`;

          await this.rollupQueue.add('rollup-user', { userId, from, to, projectId }, { 
            jobId,
            removeOnComplete: true,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 }
          });
          console.log(`🔄 Queued rollup job for user ${userId} with project ${projectId || 'None'} (Job ID: ${jobId})`);
        } catch (error) {
          console.log(`⚠️ Redis unavailable, running rollup directly`);
          await this.rollupService.rollupUserActivity(userId, from, to, projectId);
        }
      } else {
        await this.rollupService.rollupUserActivity(userId, from, to, projectId);
      }
    }

    const result = { inserted: validSamples.length, rejected: samples.length - validSamples.length };
    console.log(`📊 Result: Inserted ${result.inserted}, Rejected ${result.rejected}`);
    
    return result;
  }

  async triggerRollup(userId: string) {
    const now = new Date();
    
    // Return immediately, process in background
    setImmediate(async () => {
      try {
        const activeSession = await this.prisma.deviceSession.findFirst({
          where: { userId, endedAt: null },
          orderBy: { startedAt: 'desc' },
        });

        const lastEntry = await this.prisma.timeEntry.findFirst({
          where: { userId, source: 'AUTO' },
          orderBy: { endedAt: 'desc' },
        });

        let from: Date;
        if (lastEntry && activeSession) {
          const lookbackTime = new Date(lastEntry.endedAt.getTime() - 6 * 60 * 1000);
          from = lookbackTime > activeSession.startedAt ? lookbackTime : activeSession.startedAt;
        } else if (activeSession) {
          from = activeSession.startedAt;
        } else {
          from = new Date(now.getTime() - 6 * 60 * 1000);
        }
        
        if (this.rollupQueue) {
          try {
            const roundedFrom = Math.floor(from.getTime() / 60000) * 60000;
            const roundedTo = Math.floor(now.getTime() / 60000) * 60000;
            const jobId = `rollup-${userId}-${roundedFrom}-${roundedTo}`;

            await this.rollupQueue.add('rollup-user', { userId, from, to: now }, { 
              jobId,
              removeOnComplete: true,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1000 }
            });
          } catch (error) {
            await this.rollupService.rollupUserActivity(userId, from, now);
          }
        } else {
          await this.rollupService.rollupUserActivity(userId, from, now);
        }
      } catch (error) {
        console.error('Background rollup error:', error);
      }
    });
    
    return { success: true, message: 'Rollup triggered' };
  }

  async getActiveUsers() {
    const activeSessions = await this.prisma.deviceSession.findMany({
      where: { endedAt: null },
      include: {
        user: {
          select: { id: true, email: true, fullName: true },
        },
      },
    });

    return activeSessions.map(session => ({
      userId: session.userId,
      email: session.user.email,
      fullName: session.user.fullName,
      startedAt: session.startedAt,
      deviceId: session.deviceId,
      platform: session.platform,
    }));
  }

  async getMyStats(userId: string) {
    const now = new Date();
    // Use UTC midnight for consistent date filtering
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    
    // Get user's organization timezone
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { 
        organization: { 
          include: { organization_work_policies: true } 
        },
        tracker_profiles: true,
      },
    });
    const timezone = user?.organization?.timezone || 'UTC';
    const policy = user?.organization?.organization_work_policies;
    const trackerProfile = user?.tracker_profiles;
    
    // Get today's check-in/checkout times from device_sessions
    const firstSession = await this.prisma.deviceSession.findFirst({
      where: {
        userId,
        startedAt: { gte: today },
      },
      orderBy: { startedAt: 'asc' },
    });

    const lastSession = await this.prisma.deviceSession.findFirst({
      where: {
        userId,
        startedAt: { gte: today },
        endedAt: { not: null },
      },
      orderBy: { endedAt: 'desc' },
    });

    const checkinTime = firstSession?.startedAt || null;
    const checkoutTime = lastSession?.endedAt || null;
    
    // Get time entries for display
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        source: 'AUTO',
        startedAt: { gte: today },
      },
    });

    let activeSeconds = 0;
    let idleSeconds = 0;
    let breakSeconds = 0;
    const hourlyData: { [hour: number]: number } = {};

    for (const entry of entries) {
      const duration = Math.floor((entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000);
      if (entry.kind === 'ACTIVE') {
        activeSeconds += duration;
        
        // Calculate hourly breakdown for ACTIVE entries in minutes using organization timezone
        let current = new Date(entry.startedAt);
        const end = new Date(entry.endedAt);
        
        while (current < end) {
          // Get hour in organization timezone
          let hourStr = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            hour12: false,
          }).format(current).replace('24', '00');
          const hour = parseInt(hourStr);
          
          // Find next hour boundary using binary search
          const oneHourLater = new Date(current.getTime() + 3600000);
          let low = current.getTime();
          let high = oneHourLater.getTime();
          
          while (high - low > 1000) {
            const mid = Math.floor((low + high) / 2);
            const midDate = new Date(mid);
            let midHourStr = new Intl.DateTimeFormat('en-US', {
              timeZone: timezone,
              hour: '2-digit',
              hour12: false,
            }).format(midDate).replace('24', '00');
            const midHour = parseInt(midHourStr);
            
            if (midHour === hour) {
              low = mid;
            } else {
              high = mid;
            }
          }
          
          const nextHour = new Date(high);
          const segmentEnd = nextHour > end ? end : nextHour;
          const segmentMinutes = Math.floor((segmentEnd.getTime() - current.getTime()) / 60000);
          
          if (segmentMinutes > 0) {
            hourlyData[hour] = (hourlyData[hour] || 0) + segmentMinutes;
          }
          
          current = segmentEnd;
        }
      } else if (entry.kind === 'IDLE') {
        idleSeconds += duration;
      } else if (entry.kind === 'BREAK') {
        breakSeconds += duration;
      }
    }

    const totalSeconds = activeSeconds + idleSeconds + breakSeconds;

    let activityRate = 0;
    let calculatedBreakSeconds = 0;
    
    if (firstSession && policy) {
      // Calculate total elapsed time
      const elapsedMs = (now.getTime() - firstSession.startedAt.getTime());
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      
      // ✅ Calculate break time from schedule (not from TimeEntry)
      if (policy.break_start && policy.break_end) {
        const formatTime = (time: Date | null) => {
          if (!time) return null;
          const hours = time.getUTCHours().toString().padStart(2, '0');
          const minutes = time.getUTCMinutes().toString().padStart(2, '0');
          return `${hours}:${minutes}`;
        };
        
        const breakStart = formatTime(policy.break_start);
        const breakEnd = formatTime(policy.break_end);
        
        if (breakStart && breakEnd) {
          // Check if user was present during break time today
          const [startHour, startMin] = breakStart.split(':').map(Number);
          const [endHour, endMin] = breakEnd.split(':').map(Number);
          
          const breakStartTime = new Date(today);
          breakStartTime.setUTCHours(startHour, startMin, 0, 0);
          
          const breakEndTime = new Date(today);
          breakEndTime.setUTCHours(endHour, endMin, 0, 0);
          
          // If break end < break start, it's overnight (e.g., 23:00-01:00)
          if (breakEndTime <= breakStartTime) {
            breakEndTime.setUTCDate(breakEndTime.getUTCDate() + 1);
          }
          
          // Calculate overlap between (checkin, now) and (breakStart, breakEnd)
          const sessionStart = firstSession.startedAt.getTime();
          const sessionEnd = now.getTime();
          const breakStartMs = breakStartTime.getTime();
          const breakEndMs = breakEndTime.getTime();
          
          if (sessionEnd > breakStartMs && sessionStart < breakEndMs) {
            const overlapStart = Math.max(sessionStart, breakStartMs);
            const overlapEnd = Math.min(sessionEnd, breakEndMs);
            calculatedBreakSeconds = Math.floor((overlapEnd - overlapStart) / 1000);
            
            if (calculatedBreakSeconds < 0) calculatedBreakSeconds = 0;
          }
        }
      }

      // ✅ NEW: Calculate flexible break time from break_sessions table
      const flexibleBreaks = await this.prisma.break_sessions.findMany({
        where: {
          user_id: userId,
          break_in_time: { gte: today },
        },
      });

      for (const flexBreak of flexibleBreaks) {
        const breakStart = flexBreak.break_in_time.getTime();
        // If break is still active, use 'now' as the end time
        const breakEnd = flexBreak.break_out_time ? flexBreak.break_out_time.getTime() : now.getTime();
        
        const sessionStart = firstSession.startedAt.getTime();
        const sessionEnd = now.getTime();

        // Calculate overlap between (sessionStart, sessionEnd) and (breakStart, breakEnd)
        if (sessionEnd > breakStart && sessionStart < breakEnd) {
          const overlapStart = Math.max(sessionStart, breakStart);
          const overlapEnd = Math.min(sessionEnd, breakEnd);
          const overlapSeconds = Math.floor((overlapEnd - overlapStart) / 1000);
          
          if (overlapSeconds > 0) {
            calculatedBreakSeconds += overlapSeconds;
          }
        }
      }
      
      breakSeconds = calculatedBreakSeconds; // Update for logging
    }

    // ✅ PROFESSIONAL FIX: Calculate activity rate directly from the uploaded samples.
    // This allows the rate to drop immediately if the user stops moving the mouse/keys (even before the 5-min idle threshold).
    // Using totalSampleSeconds as the denominator prevents clock-drift race conditions.
    const samples = await this.prisma.activitySample.findMany({
      where: {
        userId,
        capturedAt: { gte: today },
      },
      select: {
        activeSeconds: true,
      },
    });

    let totalActiveSeconds = 0;
    let totalSampleSeconds = 0;

    for (const sample of samples) {
      if (sample.activeSeconds != null) {
        totalActiveSeconds += sample.activeSeconds;
        totalSampleSeconds += 5; // Each sample represents 5 seconds
      }
    }

    if (totalSampleSeconds > 0) {
      activityRate = Math.round((totalActiveSeconds / totalSampleSeconds) * 100);
      if (activityRate < 0) activityRate = 0;
      if (activityRate > 100) activityRate = 100;
    } else {
      activityRate = 100; // Default right after check-in when no samples are uploaded yet
    }

    // Removed verbose debug logs for cleaner output

    return {
      checkinTime,
      checkoutTime,
      activeSeconds,
      idleSeconds,
      breakSeconds,
      totalSeconds,
      activityRate,
      hourlyData,
    };
  }
}