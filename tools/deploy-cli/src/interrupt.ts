import { EXIT } from "./config";

// Xử lý Ctrl-C. Hàm thuần: signal thật chỉ được đăng ký ở main guard của cli.ts, nên test truyền "ngắt" vào được
// mà không cần gửi signal cho process.

export interface InterruptHandlerOptions {
    /** Yêu cầu dừng nhẹ nhàng: không bắt đầu việc mới, đợi việc đang chạy. Thường là `AbortController.abort`. */
    requestStop(): void;
    log(line: string): void;
    /** Thoát ngay. Chỉ được gọi ở lần ngắt thứ hai. */
    exitNow(code: number): void;
}

/**
 * Lần Ctrl-C đầu: dừng nhẹ nhàng (không bắt đầu domain mới, đợi domain đang chạy, in JSON, exit 130).
 * Lần thứ hai: thoát ngay, kèm cảnh báo rằng một update có thể đang dang dở.
 * Từ lần thứ ba: bỏ qua. Không bao giờ gọi `cancel` và không coi việc ngắt là rollback: những gì đã chạy vẫn còn đó.
 */
export function createInterruptHandler(options: InterruptHandlerOptions): () => void {
    let received = 0;
    return () => {
        received++;
        if (received === 1) {
            options.log(
                "Ctrl-C received: finishing the operation that is running and starting nothing new. " +
                    "Press Ctrl-C again to exit immediately (a running update is then left unfinished; nothing is rolled back).",
            );
            options.requestStop();
        } else if (received === 2) {
            options.log(
                "Second Ctrl-C: exiting now. An update may still be running or half applied. Before the next apply, " +
                    "check `pulumi stack history`, the live resources and pending operations (`pulumi stack export`).",
            );
            options.exitNow(EXIT.INTERRUPTED);
        }
    };
}
