import { callAppPlatformTool, type AppPlatformToolCaller } from '../app-platform-tool-call';

export interface NotificationResult {
  readonly delivered: boolean;
  readonly warning?: string;
}

export interface NotificationPort {
  notify(userId: string, title: string, message: string): Promise<NotificationResult>;
}

export function createNotificationPort(
  roomId: string,
  caller: AppPlatformToolCaller = callAppPlatformTool,
): NotificationPort {
  return {
    async notify(userId, title, message) {
      try {
        await caller(
          'mcpapp.notifications.create',
          { userId, title, message },
          'notifications:write',
          roomId,
        );
        return { delivered: true };
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        return { delivered: false, warning };
      }
    },
  };
}
