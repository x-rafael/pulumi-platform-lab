# Truy cập AWS của CI (GitHub Actions → OIDC → IAM role)

> Sandbox. Mô tả cách job GitHub nhận credentials AWS ngắn hạn mà không cần access key, ai được phép làm gì,
> bằng chứng đã kiểm chứng và những giới hạn còn lại.

## Hai lớp quyền khác nhau

```text
GitHub job → OIDC token → AWS STS → temporary role credentials → AWS API
                    │                │
                    │                └── permission policy: làm được gì?
                    └── trust policy: job nào được assume role?
```

`permissions: id-token: write` chỉ cho job quyền *xin token*, không cấp quyền tạo Lambda hay SQS.
Pulumi Cloud có xác thực riêng (`PULUMI_ACCESS_TOKEN`); OIDC AWS không đăng nhập Pulumi hộ.

## Role, environment và phạm vi

| Role | GitHub environment | Loại | Phạm vi resource |
| --- | --- | --- | --- |
| `lab-preview` | `preview` | chỉ đọc | stack `dev` |
| `lab-deploy-dev` | `dev` | deploy | stack `dev` |
| `lab-deploy-prod` | `prod` | deploy | stack `prod` |
| `lab-pr-env` | `pr-env` | deploy | stack `pr-*` |

Mỗi role tin đúng **một** subject, so khớp bằng `StringEquals` (không `StringLike`, không wildcard) cùng
`aud = sts.amazonaws.com`:

```text
token.actions.githubusercontent.com:sub = <REPO_SUB_PREFIX>:environment:<tên environment>
```

`REPO_SUB_PREFIX` là `repo:x-rafael@142369851/pulumi-platform-lab@1454985419` (dạng immutable: có owner ID và repo ID).
Lấy từ nguồn chính thức, không gõ tay:

```bash
gh api repos/x-rafael/pulumi-platform-lab/actions/oidc/customization/sub --jq .sub_claim_prefix
```

Code bootstrap cố ý **từ chối** dạng cũ `repo:OWNER/REPO`: tên owner/repo có thể bị đổi hoặc bị người khác đăng ký lại, ID thì không.
Nếu repo bị xoá rồi tạo lại thì ID đổi: cập nhật `githubSubPrefix` rồi `pulumi up` bootstrap.

Quyền chi tiết nằm ở `infra/bootstrap/policies.ts` (hàm thuần, có unit tests). Điểm chính:

- Tên resource khớp mẫu `platform-worker-<stack>` của `infra/worker` (function, log group, source queue `-queue`, DLQ `-dlq`, IAM role `-role`).
  Đổi quy ước đặt tên ở worker thì phải đổi ở bootstrap.
- Mẫu PR là `platform-worker-pr-*` (có dấu gạch ngang) nên không khớp `platform-worker-prod`.
- `iam:PassRole` chỉ cho đúng execution role của stack và chỉ khi `iam:PassedToService = lambda.amazonaws.com`.
- Mỗi action tạo resource đi kèm quyền gắn tag (`sqs:TagQueue`, `lambda:TagResource`, `logs:TagResource`, `iam:TagRole`).
- Smoke test (Chặng 3): `sqs:SendMessage` chỉ vào source queue của stack, đọc log của đúng log group.
- **Deny tường minh** `iam:*` trên `role/lab-*` và OIDC provider trong mọi role CI: không role CI nào sửa được trust policy
  của chính nó hay của role khác, kể cả khi sau này ai đó thêm một Allow rộng.

## Bootstrap và chủ sở hữu

| | |
| --- | --- |
| Project / stack | `platform-ci-bootstrap` · `x-rafael-org/platform-ci-bootstrap/lab` (Pulumi Cloud) |
| Resource | 1 OIDC provider `token.actions.githubusercontent.com` + 4 role + 4 inline policy (`protect: true`) |
| Chủ sở hữu | Rafael |
| Ai chạy | Chỉ admin, ở máy local (profile SSO). CI **không** chạy và không có quyền sửa |
| Vòng đời | Giữ cho Day 5/6. Không destroy cùng worker; muốn gỡ phải `pulumi state unprotect` có chủ đích |

Vì sao tách khỏi stack worker: `pulumi destroy` worker không được cắt đường vào của CI, và worker không được tự sửa quyền của chính CI.

Thay đổi quyền:

```bash
cd infra/bootstrap
npm ci && npm test                           # unit tests của policy
AWS_PROFILE=<admin> pulumi preview --stack x-rafael-org/lab
AWS_PROFILE=<admin> pulumi up --stack x-rafael-org/lab
AWS_PROFILE=<admin> ./verify-policies.sh     # IAM policy simulator trên role thật
```

Account ID không nằm trong repo hay config: lấy lúc chạy từ credentials hiện tại. ARN role nằm ở GitHub variables
(`AWS_ACCOUNT_ID`, `AWS_REGION` ở repo; `AWS_ROLE_ARN` ở từng environment), không có AWS access key trong GitHub Secrets.

## Đã kiểm chứng gì, bằng cách nào

| Điều | Cách kiểm | Kết quả |
| --- | --- | --- |
| Job GitHub assume được role bằng OIDC, đúng account | workflow `oidc-check.yml`, job `allowed` | `assumed-role/lab-preview/…`, có session token |
| Trust policy từ chối sub khác | cùng workflow: token `environment:preview` thử assume `lab-deploy-dev/prod`, `lab-pr-env` | từ chối với đúng thông báo `Not authorized to perform sts:AssumeRoleWithWebIdentity` |
| Job không có environment bị từ chối | job `no-environment` (sub `…:ref:refs/heads/main`) thử cả 4 role | cả 4 bị từ chối |
| Quyền theo phạm vi stack, PassRole, Deny tự-sửa | `verify-policies.sh` (IAM policy simulator), 61 ca dương/âm trên 4 role thật | 61 PASS, 0 FAIL |
| Cú pháp policy | IAM Access Analyzer `validate-policy` | permission policy sạch; xem cảnh báo bên dưới |
| Không có khoá dài hạn | `gh secret list` ở repo và mọi environment | 0 secret |

Bằng chứng nằm ở `keeptrack/Day4/evidence/01…03-*.txt` (ngoài repo, đã che account ID).

**Chưa kiểm chứng:** simulator chỉ đánh giá identity policy, không cho biết provider Pulumi thực sự gọi những API nào.
Quyền deploy đủ hay thiếu chỉ biết khi `pulumi up` chạy trong CI thật (Chặng 2–3). Ca âm dùng STS, vốn trả cùng một thông báo
cho role *không tồn tại*; chúng chỉ có ý nghĩa vì role đích đã được chứng minh tồn tại ở nơi khác
(ca dương cho `lab-preview`, `03-roles-and-trust.txt` cho các role còn lại).

## Nhật ký lỗi và AccessDenied

Chưa có AccessDenied nào từ CI thật (chưa có job deploy). Các phát hiện ở Chặng 1:

| Khi nào | Nguồn | Hiện tượng | Nguyên nhân / xử lý |
| --- | --- | --- | --- |
| Lần apply đầu | `CreateRole` | `ValidationError` ở `description` | Mô tả chứa ký tự `→` (U+2192); IAM chỉ nhận ASCII và Latin-1. Đổi sang ASCII, thêm test với đúng regex của IAM |
| Khi chạy simulator | `lambda:CreateEventSourceMapping` | `implicitDeny` dù Resource là ARN mapping + đúng điều kiện | Create không hỗ trợ resource-level (ARN chưa tồn tại lúc tạo). Chuyển sang `Resource: "*"` giữ nguyên điều kiện `lambda:FunctionArn`; `UpdateEventSourceMapping` thì giữ ARN mapping. Simulator xác nhận lại |
| Khi validate | Access Analyzer, trust policy | Cảnh báo `SPECIFIC_GITHUB_REPO_AND_BRANCH_RECOMMENDED` dù sub không có wildcard | Cùng cảnh báo với cả dạng sub cũ: sub theo environment không chứa tên branch. Ranh giới branch đặt ở deployment branch policy của environment `dev`/`prod` (chỉ `main`), xem bên dưới |

Khi gặp AccessDenied thật ở Chặng 2–3, thêm một dòng: action thiếu, resource, vì sao cần, và commit sửa.

## Giới hạn đã biết

- **Chưa có permissions boundary.** Role deploy có `iam:PutRolePolicy` trên execution role của worker và `lambda:UpdateFunctionCode`,
  nên về nguyên tắc có thể nâng quyền trong phạm vi tên `platform-worker-*`. Cách chặn: điều kiện `iam:PermissionsBoundary`
  trên `CreateRole`/`PutRolePolicy` cộng việc worker gắn boundary. Chưa làm; chấp nhận trong sandbox một người dùng.
- **Hai statement liệt kê không giới hạn được theo tên:** `logs:DescribeLogGroups` (trên `log-group:*`) và
  `lambda:ListEventSourceMappings` (`*`). Chỉ lộ metadata, không đọc/ghi dữ liệu.
- **Event source mapping:** Get/Delete/Tag dùng UUID nên không giới hạn được theo tên (Create/Update thì có điều kiện function).
- **Environment là ranh giới, nên phải được bảo vệ.** Workflow ở branch bất kỳ tham chiếu `environment: <tên>` chưa tồn tại sẽ tự tạo
  environment không bảo vệ. Hiện: `dev` và `prod` chỉ cho deploy từ `main`; `preview` không giới hạn branch (role chỉ đọc, dùng cho PR do
  chủ repo kiểm soát); `pr-env` **chưa được tạo**, sẽ tạo với rule phù hợp ở Chặng 4 (đến lúc đó chỉ PR tin cậy trong cùng repo).
  Required reviewers của `prod` làm ở Chặng 3.
- **Repo private ở tài khoản cá nhân (gói Free):** tạo Environment và branch policy của environment được (đã kiểm). Đã kiểm bằng API ngày 2026-11-12:
  - `GET /repos/x-rafael/pulumi-platform-lab/rulesets` và `/branches/main/protection` đều trả 403
    `Upgrade to GitHub Pro or make this repository public to enable this feature.` Nên **không đặt được required check `unit`**
    và một check đỏ **không chặn** được merge (chỉ là tín hiệu cho người merge).
  - Merge queue chỉ có với repo thuộc organization (chủ repo ở đây là `User`), nên trigger `merge_group` trong `ci.yml` **đã viết, chưa kiểm chứng queue**.
  - Required reviewers của environment `prod` (Chặng 3) có thể gặp cùng giới hạn; kiểm bằng API trước khi tuyên bố gate có tác dụng.
  Các lựa chọn: chuyển repo public sau khi review nội dung, nâng cấp GitHub Pro, hoặc chấp nhận gate chưa thực nghiệm và ghi đúng như vậy.

## Pulumi Cloud token trong CI

Pulumi Cloud xác thực riêng; role AWS ở trên không đăng nhập Pulumi hộ. CI dùng secret `PULUMI_ACCESS_TOKEN`.

- **Chỉ ở environment secret của `preview`** (không phải repo secret), nên job `unit` và mọi job không khai `environment: preview` không thấy token.
- **Rủi ro cần biết:** ở gói hiện tại token là *personal access token*, có quyền của chính chủ trên **mọi stack trong `x-rafael-org`**, kể cả
  `platform-ci-bootstrap/lab`. Environment `preview` không giới hạn branch, nên bất kỳ branch nào trong repo tham chiếu `environment: preview` đều nhận được token.
  Chặn hậu quả phía AWS vẫn là role `lab-preview` chỉ đọc; nhưng phía Pulumi thì token không bị thu hẹp. Chỉ chủ repo có quyền ghi, và fork không chạy job `preview`.
  Muốn thu hẹp: org/team token (tính năng trả phí) hoặc Pulumi OIDC issuer; chưa dùng.
- **Tạo/xoay:** app.pulumi.com → Settings → Access Tokens → New token (ghi mô tả và đặt hạn dùng). Rồi, ở terminal của bạn (dán token ở prompt, không dán vào chat/log):

  ```bash
  gh secret set PULUMI_ACCESS_TOKEN --repo x-rafael/pulumi-platform-lab --env preview
  gh secret list --repo x-rafael/pulumi-platform-lab --env preview     # chỉ thấy tên và ngày, không thấy giá trị
  ```

  Xoay token: tạo token mới, `gh secret set` lại, rồi thu hồi token cũ trong Pulumi Cloud.
