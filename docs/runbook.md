# Runbook vận hành

> Sandbox học tập. Tài liệu này nói cái gì đang chạy, ai sở hữu, và các lệnh để vận hành. Thiết kế quyền nằm ở [ci-access.md](ci-access.md),
> vòng đời PR environment ở [pr-environments.md](pr-environments.md). Mọi lệnh `gh` dùng `--repo x-rafael/pulumi-platform-lab`.

## Đang chạy gì (ghi nhận 2026-11-13, sau khi dựng lại `dev` bằng deploy CLI)

| Thành phần | Trạng thái | Chủ sở hữu | Ghi chú |
| --- | --- | --- | --- |
| Stack `platform-worker/dev` | **11 resource + 1 StackReference** (SQS + DLQ, Lambda, IAM role, log group, event source mapping); Lambda có `MESSAGE_PREFIX=lab` | Rafael | Dựng lại 2026-11-13 **bằng deploy CLI từ máy local** (admin SSO), không phải role CI. Lần destroy trước (2026-11-12) là bằng role CI `lab-deploy-dev` |
| Stack `platform-config/dev` | **1 resource**: SSM String parameter `/platform-lab/dev/message-prefix` = `lab`; export `messagePrefix` | Rafael | Tạo bằng `pulumi stack init` (bootstrap có chủ đích) rồi apply bằng deploy CLI từ máy local. Worker đọc output này qua StackReference |
| Workflow `Deploy dev` | **ĐÃ TẮT** (`disabled_manually`) | Rafael | Nó chạy mỗi lần push vào `main`. Chưa nên bật lại: CI chưa biết `platform-config` (token Pulumi của CI có đọc được `platform-config/dev` không thì chưa kiểm chứng, role CI không có quyền SSM) |
| Stack `platform-worker/prod` | 0 resource (chỉ config) | Rafael | Chưa từng deploy worker prod |
| Stack `platform-ci-bootstrap/lab` | 11 resource, `protect: true` | Rafael | OIDC provider + 4 role `lab-*` + 4 inline policy. **Giữ lại** cho Day 5/6 |
| Reaper theo lịch | **BẬT**, dọn thật mỗi 6 giờ | Rafael | Chỉ xét stack `pr-<n>` có tag khớp; hiện không có stack nào. Chưa có lần chạy tự động nào được quan sát (kiểm: `gh run list --workflow "PR environment reaper" --event schedule`; lúc không có stack `pr-*` thì chỉ loại `dev`/`prod`, không dispatch gì). GitHub tự tắt workflow theo lịch của repo public sau 60 ngày không có hoạt động trong repo, nên "chạy cho tới khi bạn tắt" chỉ đúng khi repo còn được dùng |
| Pulumi OIDC issuer `github-actions` | 4 policy (`preview`, `dev`, `prod`, `pr-env`) | Rafael | Cấu hình trên giao diện Pulumi Cloud |
| GitHub | repo public; secret `AWS_ACCOUNT_ID` (để mask log); ruleset `protect-main` (admin bypass); environment `preview`, `dev`, `prod` (reviewer), `pr-env` | Rafael | |

Chi phí: IAM và SSM Standard parameter không tốn phí; Lambda, SQS và CloudWatch Logs của `dev` đang chạy nhưng không có traffic nên chi phí rất thấp. Vẫn nên dọn khi hết dùng (thứ tự ở cuối tài liệu).

## Việc thường làm

| Việc | Lệnh | Ghi chú |
| --- | --- | --- |
| Deploy dev | `gh workflow enable "Deploy dev"` rồi push vào `main` (hoặc `gh workflow run deploy-dev.yml`) | Build, test, preview, up, smoke test. Cùng concurrency group với destroy |
| Dọn dev | `gh workflow run destroy-dev.yml -f confirm=dev` rồi `gh workflow disable "Deploy dev"` | Phải **tắt** deploy, nếu không push kế tiếp tạo lại resource. **Chỉ dọn worker.** Dọn config SAU, bằng quyền admin: `pulumi destroy --stack YOUR_ORG/platform-config/dev`. Chưa kiểm chứng: destroy bằng role CI có chạy được khi stack có StackReference không (`destroy --refresh` đọc lại StackReference bằng token Pulumi của CI) |
| Preview / check / apply bằng CLI | `cd tools/deploy-cli && AWS_PROFILE=<profile> PULUMI_ORG=<org> npm run -s deploy -- --domain all --env dev [--check \| --apply]` | Config chạy trước worker; `--apply` chỉ cho `dev`; exit 0/1/2/64 (xem README). CLI chỉ chọn stack có sẵn, không tạo stack |
| Thử cổng prod | `gh workflow run prod-preview.yml`, rồi duyệt trên giao diện GitHub | Chỉ `pulumi preview`. Owner tự duyệt, không phải duyệt độc lập |
| PR environment | tự động khi mở/push/đóng PR cùng repo | Dọn tay: `gh workflow run pr-env-destroy.yml -f pr=<n>` (chỉ xoá nếu PR đã đóng hoặc TTL hết) |
| Xem reaper sẽ làm gì | `gh workflow run pr-env-reaper.yml` (mặc định dry run) | Thêm `-f dry_run=false` để dọn thật |
| Tắt / bật reaper | `gh workflow disable "PR environment reaper"` / `enable` | |
| Kiểm Pulumi login của từng environment | `gh workflow run oidc-check.yml` (thêm `-f include_prod=true` nếu muốn, sẽ phải duyệt) | |
| Sửa quyền role CI | sửa `infra/bootstrap/policies.ts` → `npm test` → `pulumi preview` / `pulumi up` bằng quyền admin → `./verify-policies.sh` | CI không tự sửa được quyền của chính nó (Deny `iam:*` trên `role/lab-*`) |

## Xử lý sự cố

| Triệu chứng | Kiểm tra trước |
| --- | --- |
| `AssumeRoleWithWebIdentity` bị từ chối | `sub` thật của job (có đúng `…:environment:<tên>`?), environment có tồn tại, ID repo/owner trong trust policy (`gh api repos/<repo>/actions/oidc/customization/sub`). Không mở wildcard để "cho qua" |
| AWS qua nhưng Pulumi bị từ chối (401 `access_denied`) | Policy Pulumi của environment đó có chưa và có đúng Aud/Sub/Scope không (mỗi environment một policy) |
| Job PR `preview` / `pr-env` không chạy | `if` của job (PR từ fork bị loại), `unit` có xanh không, environment và biến `AWS_ROLE_ARN` |
| Thiếu artifact khi `pulumi up` | Có bước `npm run build:handler` và `work-dir` đúng chưa (Pulumi đọc `./dist`) |
| Hai deploy va nhau | Concurrency group `deploy-platform-worker-dev`; cuối cùng là khoá của backend Pulumi |
| Đóng PR nhưng resource còn | Xem run `PR environment cleanup` của PR đó; thử lại bằng `gh run rerun <id> --failed`; reaper sẽ nhặt lại sau tối đa 6 giờ. **Không xoá state** |
| Preview worker lỗi `Required output 'messagePrefix' does not exist on stack …` | Stack config chưa được deploy hoặc `configStack` sai. Deploy config trước (`--domain config --apply`) hoặc dùng `--domain all`. Không tạo output giả |
| CLI báo `stack … does not exist. This CLI never creates stacks` | Tạo stack có chủ đích: `pulumi stack init <org>/<project>/<stack>`, rồi đặt `aws:region` và `<project>:environment`. CLI không tự tạo |
| `pulumi up` gõ tay trong `infra/*` trúng stack không định | Deploy CLI dùng `selectStack` nên đổi stack đang chọn của thư mục đó. Khi gõ tay luôn truyền `--stack` |
| `destroy` lỗi `AccessDenied … on resource: *` | Resource (vd. event source mapping) đã mất nên IAM đánh giá với `*`; `destroy --refresh` xử lý được ca thử lại. Xem nhật ký trong ci-access.md |
| Cổng `prod` không chờ ai | Environment `prod` chưa có required reviewers (kiểm trong Settings hoặc API) |
| Log công khai lộ account ID | `AWS_ACCOUNT_ID` phải là **secret** và job phải tham chiếu nó; xoá run bị lộ (`gh run delete`) |

## Gỡ hoàn toàn (khi hết dùng lab) — chưa thử, chỉ là thứ tự an toàn

1. Tắt reaper; destroy mọi stack `pr-*` còn lại (đóng PR hoặc `pr-env-destroy.yml`); destroy worker `dev` (`destroy-dev.yml`); rồi destroy `platform-config/dev` bằng quyền admin (worker trước vì nó tham chiếu config).
2. Xoá policy trên Pulumi OIDC issuer; xoá secret và variable của repo.
3. Bootstrap: `pulumi state unprotect --all` rồi `pulumi destroy` trên `platform-ci-bootstrap/lab` bằng quyền admin. **Làm cuối**, vì sau bước này CI mất đường vào AWS.
4. Xoá stack Pulumi rỗng (`dev`, `prod`, `lab`, và `dev` của `platform-config`) nếu muốn. Không cần xoá repo hay lịch sử workflow.
