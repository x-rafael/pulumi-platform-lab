# PR environments

> Sandbox. Mỗi pull request cùng repo có đúng một stack tạm `pr-<số PR>` của worker (SQS + DLQ + Lambda + log group + IAM role;
> không ALB/NAT). Tạo khi mở PR, cập nhật khi push, xoá khi đóng PR hoặc khi hết TTL 24 giờ.
> Quyền AWS/Pulumi của các workflow này và nhật ký AccessDenied nằm ở [ci-access.md](ci-access.md).

## Vòng đời

| Sự kiện | Việc xảy ra | Nơi |
| --- | --- | --- |
| PR mở / mở lại / push thêm commit | `unit` xanh → kiểm PR còn mở và cùng repo → tạo hoặc chọn stack → dựng tag + config → `preview` → `up` → smoke test | job `pr-env` trong [ci.yml](../.github/workflows/ci.yml) |
| PR đóng | kiểm lại PR/TTL/tag → `destroy` → xác nhận stack rỗng và AWS không còn resource → `stack rm` | [pr-env-destroy.yml](../.github/workflows/pr-env-destroy.yml) |
| Mỗi 6 giờ (và chạy tay) | quét stack, chọn stack cần dọn, giao từng PR cho workflow dọn dẹp | [pr-env-reaper.yml](../.github/workflows/pr-env-reaper.yml) |

Logic nằm ở [scripts/pr-env.ts](../scripts/pr-env.ts) (`up`, `destroy`, `reap [--dry-run]`); phần quyết định là hàm thuần có test ([scripts/tests](../scripts/tests)).
Day 5 sẽ chuyển phần điều phối này sang Pulumi Automation API.

## Thiết kế

- **Tên và metadata.** Stack `x-rafael-org/platform-worker/pr-<n>` dựng từ allowlist org/project cố định, không nhận tên từ PR. Tên vật lý chứa tên stack
  (`platform-worker-pr-<n>`, `…-queue`, `…-dlq`, `…-role`) nên không đụng stack `dev`.
- **Tag của stack là nguồn sự thật cho reaper.** Với backend Pulumi Cloud, config nằm trong file `Pulumi.<stack>.yaml` ở máy, còn tag nằm trên service. Checkout mới
  (workflow dọn, reaper) không có file config, nên các tag `Purpose=pr-environment`, `ManagedBy=Pulumi`, `Repository`, `PR`, `ExpiresAt` là thứ duy nhất nó đọc được.
  Config được dựng lại **mỗi lần** chạy (`aws:region`, `environment=dev`, `prNumber`, `expiresAt`, `repository`); `Pulumi.pr-*.yaml` bị `.gitignore`.
  Cùng các giá trị đó cũng thành tag AWS trên resource hỗ trợ tags.
- **TTL 24 giờ tính từ lúc tạo.** Push thêm commit không kéo dài (stack đã có `ExpiresAt` hợp lệ thì giữ nguyên). Để xin TTL mới: đóng rồi mở lại PR.
- **Concurrency.** Job `pr-env` và workflow dọn dẹp dùng cùng group `pr-platform-worker-<số PR>`, `cancel-in-progress: false`: up và destroy của một PR không chạy chồng
  và không huỷ giữa chừng. Reaper không tự destroy mà giao việc cho workflow dọn dẹp để việc dọn nằm trong đúng group đó. Như mọi concurrency của GitHub, đây không phải
  hàng đợi (run đang chờ bị thay bằng run mới hơn) và không thay cho khoá backend của Pulumi.

## Quy tắc an toàn (đều có test)

- Số PR đến từ sự kiện/input qua biến môi trường, được kiểm là số nguyên dương; không bao giờ dùng tiêu đề hay nội dung PR; lệnh chạy bằng argv, không qua shell.
- `up` chỉ chạy khi PR còn mở và **cùng repo** (fork không nhận credentials); không xác minh được PR thì từ chối.
- `pulumi stack ls` thất bại thì dừng, **không** rơi sang `stack init` (lỗi xác thực/backend không có nghĩa là chưa có stack). Nhánh dọn không bao giờ `stack init`.
- `destroy`: kiểm tag khớp (Repository, Purpose, ManagedBy, PR, ExpiresAt) → kiểm lại PR/TTL sau khi có lượt chạy → `pulumi destroy --refresh` (không `--force`) →
  stack rỗng → AWS xác nhận cả 5 resource đã mất → mới `stack rm`. Chỉ các mã "không tồn tại" thật (`ResourceNotFoundException`, `NonExistentQueue`, `NoSuchEntity`,
  danh sách log group rỗng) mới tính là đã xoá; AccessDenied hay lỗi mạng làm bước kiểm thất bại, không bị coi là "đã xoá".
- Lỗi destroy giữ nguyên state để thử lại. `--refresh` làm cho lần thử lại idempotent (xem nhật ký trong ci-access.md).

## Quyết định của reaper

| Điều kiện | Quyết định |
| --- | --- |
| Tên không phải `pr-<số nguyên dương>` (`dev`, `prod`, `test`, tên lạ) | **loại**, không bao giờ xoá |
| Thiếu hoặc sai `Purpose`, `ManagedBy`, `Repository`, `PR` (không khớp tên), hoặc `ExpiresAt` không hợp lệ | **loại** |
| PR đã đóng | **dọn** |
| PR còn mở nhưng `ExpiresAt` đã qua (UTC) | **dọn** |
| Tra cứu GitHub lỗi / không thấy PR và TTL chưa hết | **giữ** (không xoá khi thông tin mơ hồ) |
| PR mở và TTL còn hạn | **giữ** |

- **Lịch chạy dọn THẬT** (mỗi 6 giờ, 23 phút). Nếu lịch chỉ chạy thử thì TTL không bao giờ được thực thi. Lịch này **sẽ tiếp tục chạy** cho tới khi bị tắt:
  `gh workflow disable "PR environment reaper"`. Chạy tay mặc định là dry run (`dry_run: true`).
- Một stack bị reaper dọn khi PR còn mở sẽ được tạo lại (TTL mới) ở lần push kế tiếp.
- SQS không cho tạo lại queue cùng tên trong 60 giây sau khi xoá: đừng mở lại PR ngay sau khi vừa đóng.

## Đã kiểm chứng (ngày 2026-11-12, dev song song, stack `dev` không bị chạm)

| Kịch bản | Run | Kết quả |
| --- | --- | --- |
| Mở PR #5 | CI 43227200228 | `pr-5` tạo mới: 11 resource, `up` 1m34s, smoke `processed` (poll 2); tag đúng trên stack và Lambda |
| Push commit đổi handler | CI 43227969631 | cùng stack: `~ 1 to update, 10 unchanged`, `ExpiresAt` giữ nguyên, `CodeSha256` của Lambda đổi, vẫn một stack `pr-*` |
| Đóng PR #5 | cleanup 43228386404 | lần 1–3 **lỗi AccessDenied thật** (ci-access.md), lần 4: `10 deleted`, rỗng trên Pulumi và AWS, stack đã xoá (xác nhận độc lập bằng quyền admin) |
| Mở PR #6, reaper dry-run | reaper 43231928194 | `dev`, `prod` loại kèm lý do; `pr-6` **giữ** (PR mở, TTL còn hạn) |
| Chỉnh tag `ExpiresAt` của `pr-6` về quá khứ (bằng tay, tag AWS không đổi) rồi dry-run | reaper 43232431780 | chọn đúng `pr-6` (`TTL expired`); `dev`, `prod` loại; không dispatch gì |
| Reaper chạy thật | reaper 43232842389 → cleanup 43232897510 | dispatch được bằng `GITHUB_TOKEN` (`actions: write`); `11 deleted` (1m50s), xác nhận rỗng |
| Đóng PR #6 (stack đã mất) | cleanup 43233412758 | no-op thành công, không `stack init`, AWS sạch |
| `unit` của repo | mọi run | gồm test của `scripts/` (88 ca) và bootstrap (71 ca) |

Số đo: `up` khoảng 1m34s; `destroy` 1m35s–1m50s (mỗi queue mất khoảng 45 giây để xoá).

## Giới hạn

- Job `pr-env` **chạy code của PR** với role `lab-pr-env` (đó là mục đích: deploy code của PR). Ranh giới tin cậy là quyền ghi vào repo; PR từ fork không nhận credentials.
  Workflow dọn dẹp lấy script từ `main`, không từ PR đã đóng, nhưng bản thân file workflow của sự kiện `pull_request: closed` vẫn là bản của PR.
- Environment `pr-env` không có branch policy (xem ci-access.md).
- Test reaper dùng tag `ExpiresAt` sửa bằng tay; tag `ExpiresAt` trên resource AWS lúc đó lệch với tag của stack.
- Chưa thử: PR từ fork thật (chặn bằng `if` ở workflow và kiểm `headRepository` trong script, có unit test), nhánh `Reject` của cổng prod là việc khác.
