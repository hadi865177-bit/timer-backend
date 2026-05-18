import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrganizationsService {
  constructor(private prisma: PrismaService) {}

  private formatTime(time: Date | null) {
    if (!time) return null;
    const hours = time.getUTCHours().toString().padStart(2, '0');
    const minutes = time.getUTCMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  async getOrganization(orgId: string) {
    return this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, timezone: true },
    });
  }

  async getSchedule(orgId: string, userId: string) {
    console.log(`🔍 Schedule Request - Org: ${orgId}, User: ${userId}`);
    
    const workPolicy = await this.prisma.organization_work_policies.findFirst({
      where: { organization_id: orgId },
      include: { organizations: { select: { timezone: true } } },
    });

    const trackerProfile = await this.prisma.tracker_profiles.findUnique({
      where: { user_id: userId },
    });

    const isFlexible = (trackerProfile as any)?.is_flexible_break ?? false;
    console.log(`📋 Policy: ${workPolicy ? 'Found' : 'Not Found'} | Flexible Break: ${isFlexible ? 'ENABLED ✅' : 'DISABLED ❌'}`);

    if (!workPolicy) {
      return {
        tz: 'UTC',
        checkinStart: '09:00',
        checkinEnd: '18:00',
        breakStart: '12:00',
        breakEnd: '13:00',
        idleThresholdSeconds: 300,
        screenshotIntervalMinutes: 10,
        isFlexibleBreak: isFlexible,
      };
    }

    const rules = {
      tz: workPolicy.organizations?.timezone || 'UTC',
      checkinStart: this.formatTime(trackerProfile?.custom_schedule_start) || this.formatTime(workPolicy.shift_start) || '09:00',
      checkinEnd: this.formatTime(trackerProfile?.custom_schedule_end) || this.formatTime(workPolicy.shift_end) || '18:00',
      breakStart: isFlexible ? null : (this.formatTime(trackerProfile?.custom_break_start) || this.formatTime(workPolicy.break_start) || '12:00'),
      breakEnd: isFlexible ? null : (this.formatTime(trackerProfile?.custom_break_end) || this.formatTime(workPolicy.break_end) || '13:00'),
      idleThresholdSeconds: workPolicy.idle_threshold_seconds || 300,
      screenshotIntervalMinutes: workPolicy.screenshot_interval_minutes || 10,
      isFlexibleBreak: isFlexible,
    };

    console.log('📅 Final Schedule Rules:', JSON.stringify(rules, null, 2));

    if (isFlexible) {
      console.log(`✨ User ${userId} is in Flexible Mode. Schedule breaks are ignored.`);
    } else {
      console.log(`⏰ User ${userId} is in Fixed Mode. Break window: ${rules.breakStart} - ${rules.breakEnd}`);
    }

    return rules;
  }
}
