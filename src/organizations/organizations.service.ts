import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrganizationsService {
  constructor(private prisma: PrismaService) {}

  async getOrganization(orgId: string) {
    return this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, timezone: true },
    });
  }

  async getSchedule(orgId: string, userId?: string) {
    console.log('🔍 Looking for work policy - orgId:', orgId);
    
    const workPolicy = await this.prisma.organization_work_policies.findFirst({
      where: { organization_id: orgId },
      include: { organizations: { select: { timezone: true } } },
    });

    console.log('📋 Work policy found:', workPolicy ? 'Yes' : 'No');

    if (!workPolicy) {
      console.log('⚠️  No work policy found, returning defaults');
      return {
        tz: 'UTC',
        checkinStart: '09:00',
        checkinEnd: '18:00',
        breakStart: '12:00',
        breakEnd: '13:00',
        idleThresholdSeconds: 300,
        screenshotIntervalMinutes: 10,
      };
    }

    // Get user's custom break time if userId provided
    let customBreakStart = null;
    let customBreakEnd = null;
    
    if (userId) {
      const trackerProfile = await this.prisma.tracker_profiles.findUnique({
        where: { user_id: userId },
        select: { custom_break_start: true, custom_break_end: true },
      });
      
      if (trackerProfile) {
        customBreakStart = trackerProfile.custom_break_start;
        customBreakEnd = trackerProfile.custom_break_end;
        console.log('✅ Custom break found:', customBreakStart, '-', customBreakEnd);
      }
    }

    return {
      tz: workPolicy.organizations?.timezone || 'UTC',
      checkinStart: workPolicy.shift_start?.toString() || '09:00',
      checkinEnd: workPolicy.shift_end?.toString() || '18:00',
      breakStart: customBreakStart?.toString() || workPolicy.break_start?.toString() || '12:00',
      breakEnd: customBreakEnd?.toString() || workPolicy.break_end?.toString() || '13:00',
      idleThresholdSeconds: workPolicy.idle_threshold_seconds || 300,
      screenshotIntervalMinutes: workPolicy.screenshot_interval_minutes || 10,
    };
  }
}
