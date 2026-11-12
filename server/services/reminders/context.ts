import { DEFAULT_NOTIFICATION_PREFS } from "@server/db/repos/notifications";
import type { RecipientContext } from "./plan";
import { sendZone } from "./policy";
import type { AudienceRow, UserSettings } from "./store";

/**
 * A recipient's sending context. Accounts use their profile zone, else their Institution's;
 * Remind-me contacts have no stored zone yet, so they get the 22:30 UTC rule and default prefs.
 * The weekly email is on only while email is on (the channel switch covers every list today).
 */
export function recipientContext(row: Pick<AudienceRow, "recipientKey" | "userId" | "contactId">, settings: UserSettings | undefined): RecipientContext {
  const prefs = settings?.prefs ?? DEFAULT_NOTIFICATION_PREFS;
  const zone = row.userId && settings ? sendZone(settings.profileZone, settings.institutionZone) : null;
  const quiet: readonly [string, string] = [prefs.quietHoursStart, prefs.quietHoursEnd];
  return {
    recipientKey: row.recipientKey,
    userId: row.userId,
    contactId: row.contactId,
    zone,
    institutionId: settings?.institutionId ?? null,
    quiet,
    weekly: {
      recipientKey: row.recipientKey,
      zone,
      weeklyEmail: prefs.weeklyEmail && prefs.channels.email,
      weeklyDay: prefs.weeklyDay,
      quiet,
      examPauseUntil: prefs.examPauseUntil,
    },
  };
}
