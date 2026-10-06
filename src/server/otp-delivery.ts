import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HttpError } from "./errors";

export type OtpMessage = {
  challengeId: string;
  email: string;
  code: string;
  expiresAt: string;
};
export interface OtpDelivery {
  send(message: OtpMessage): Promise<void>;
}

/** A test dependency, never exposed through a route or ordinary application log. */
export class SyntheticMailbox implements OtpDelivery {
  readonly messages = new Map<string, OtpMessage>();
  async send(message: OtpMessage) {
    this.messages.set(message.challengeId, { ...message });
  }
}

const memoryMailbox = new SyntheticMailbox();

export function configuredOtpDelivery(): OtpDelivery {
  if (
    process.env.APP_MODE !== "INTERNAL" ||
    process.env.OTP_ADAPTER !== "synthetic-v1"
  ) {
    throw new HttpError(503, "验证码服务尚未配置。");
  }
  const directory = process.env.E4_SYNTHETIC_MAILBOX_DIR;
  if (!directory) return memoryMailbox;
  if (!isAbsolute(directory))
    throw new Error("Synthetic mailbox must be absolute");
  return {
    async send(message) {
      // Only the isolated test harness supplies this private, temporary directory.
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, `${message.challengeId}.json`),
        JSON.stringify(message),
        { mode: 0o600, flag: "wx" },
      );
    },
  };
}
