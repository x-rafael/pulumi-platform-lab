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

Account ID không nằm trong repo hay config: bootstrap lấy lúc chạy từ credentials hiện tại. ARN role nằm ở GitHub variables
(`AWS_REGION` ở repo; `AWS_ROLE_ARN` ở từng environment). Không có AWS access key hay credential nào trong GitHub.

**`AWS_ACCOUNT_ID` là một GitHub *secret*, nhưng không phải credential.** Account ID không bí mật theo phân loại của AWS; nó là secret chỉ để
GitHub tự mask trong log của repo public (biến thường thì không được mask, và runner in lại `with:`/`env:` đã khai triển của từng bước, nên cả
một bước `::add-mask::` cũng tự làm lộ ID). Secret được mask ở mọi chỗ, kể cả khi ID nằm giữa chuỗi ARN. Phát hiện này đến từ việc rà log
trước khi chuyển repo sang public: 6/8 run đầu tiên in ID thật.

## Đã kiểm chứng gì, bằng cách nào

| Điều | Cách kiểm | Kết quả |
| --- | --- | --- |
| Job GitHub assume được role bằng OIDC, đúng account | workflow `oidc-check.yml`, job `allowed` | `assumed-role/lab-preview/…`, có session token |
| Trust policy từ chối sub khác | cùng workflow: token `environment:preview` thử assume `lab-deploy-dev/prod`, `lab-pr-env` | từ chối với đúng thông báo `Not authorized to perform sts:AssumeRoleWithWebIdentity` |
| Job không có environment bị từ chối | job `no-environment` (sub `…:ref:refs/heads/main`) thử cả 4 role | cả 4 bị từ chối |
| Quyền theo phạm vi stack, PassRole, Deny tự-sửa | `verify-policies.sh` (IAM policy simulator), 61 ca dương/âm trên 4 role thật | 61 PASS, 0 FAIL |
| Cú pháp policy | IAM Access Analyzer `validate-policy` | permission policy sạch; xem cảnh báo bên dưới |
| Không có khoá dài hạn | `gh secret list` ở repo và mọi environment | chỉ có `AWS_ACCOUNT_ID` (account ID để mask log, không phải credential); không có AWS key, không có Pulumi token |
| CI thật: unit + preview, cả AWS lẫn Pulumi Cloud đăng nhập bằng OIDC | PR #1, run 43191003578 | unit 39s, preview 50s; `OIDC token exchange performed successfully`; `+ 11 to create`; không AccessDenied |
| Policy Pulumi từ chối sub khác (một phần) | `oidc-check.yml` run 43192266735: job không environment so với job `preview`, cùng input | `401 access_denied` cho job không environment; job `preview` nhận token. Sub của `pr-env` và của repo khác chưa kiểm |
| Policy Pulumi của `dev`/`prod`: từ chối trước, cho phép sau khi thêm policy | `oidc-check.yml` run 43216318729 (`denied`) rồi 43218073008 (`allowed`) | trước: `401 access_denied` cả hai (loại trừ policy dạng `…:environment:*`); sau: nhận token cả hai, job không environment vẫn bị từ chối |
| Deploy dev thật bằng `lab-deploy-dev` + smoke test | `deploy-dev.yml` run 43218214696 (tạo mới), 43219275793 (no-op) | `+ 11 created` (1m24s), smoke `processed` ở poll 3; lần hai `11 unchanged`. Job 156s và 69s |
| `lab-preview` đủ quyền đọc trên stack có resource thật | PR probe #3 (rỗng, đã đóng), run 43218848378: `preview --refresh` | `11 unchanged`, không AccessDenied; CloudTrail của phiên: 0 lỗi |
| Cổng phê duyệt environment `prod` | `prod-preview.yml` run 43219292785 | job `waiting`, chưa runner/bước nào chạy; sau khi **owner tự phê duyệt**: assume `lab-deploy-prod`, preview prod `+ 11 to create`. Không phải phê duyệt độc lập |
| Test lỗi làm check đỏ và preview không nhận credentials | PR demo #2 (đã đóng không merge), run 43191426545 | `unit` failure ở bước `worker - test`; `preview` skipped. PR vẫn `MERGEABLE`: check đỏ **không chặn** merge ở gói này |

Bằng chứng nằm ở `keeptrack/Day4/evidence/01…06-*.txt` (ngoài repo, đã che account ID).

> Các run 43185395051, 43191003578, 43191716209, 43192266735, 43192272296 và 43192438296 được trích dẫn ở trên đã bị **xoá** trước khi chuyển repo sang public, vì log in account ID thật. Kết quả của chúng được lưu ở file bằng chứng nói trên. Run 43212367473 (trên `main`) là bản log đã mask và còn tồn tại.

**Đã chạy thật ở Chặng 3:** create (đủ 11 resource, gồm PassRole và tag-on-create), refresh, no-op update, smoke test và preview của `lab-preview`.
**Chưa chạy bằng role CI:** update tại chỗ (`UpdateFunctionCode`, `UpdateFunctionConfiguration`, `SetQueueAttributes`, `UpdateEventSourceMapping`) và **destroy**
(`DeleteFunction`, `DeleteQueue`, `DeleteLogGroup`, `DeleteRole`, `DeleteRolePolicy`, `DeleteEventSourceMapping`); destroy được thử ở Chặng 4 (`lab-pr-env`).
Simulator chỉ đánh giá identity policy, không cho biết provider Pulumi thực sự gọi những API nào. Ca âm dùng STS, vốn trả cùng một thông báo
cho role *không tồn tại*; chúng chỉ có ý nghĩa vì role đích đã được chứng minh tồn tại ở nơi khác
(ca dương cho `lab-preview`, `03-roles-and-trust.txt` cho các role còn lại).

## Nhật ký lỗi và AccessDenied

**Chưa có AccessDenied nào từ CI thật** (Chặng 3 đối chiếu bằng CloudTrail: 0 `AccessDenied`/`Unauthorized` ở mọi phiên role CI có dữ liệu), nên Chặng 3 không phải sửa policy bootstrap lần nào. Preview của PR #1 (stack rỗng) không chứng minh được quyền đọc; PR probe #3 trên stack có 11 resource thật mới là phép thử, và nó qua. Các phát hiện:

| Khi nào | Nguồn | Hiện tượng | Nguyên nhân / xử lý |
| --- | --- | --- | --- |
| Lần apply đầu | `CreateRole` | `ValidationError` ở `description` | Mô tả chứa ký tự `→` (U+2192); IAM chỉ nhận ASCII và Latin-1. Đổi sang ASCII, thêm test với đúng regex của IAM |
| Khi chạy simulator | `lambda:CreateEventSourceMapping` | `implicitDeny` dù Resource là ARN mapping + đúng điều kiện | Create không hỗ trợ resource-level (ARN chưa tồn tại lúc tạo). Chuyển sang `Resource: "*"` giữ nguyên điều kiện `lambda:FunctionArn`; `UpdateEventSourceMapping` thì giữ ARN mapping. Simulator xác nhận lại |
| Khi validate | Access Analyzer, trust policy | Cảnh báo `SPECIFIC_GITHUB_REPO_AND_BRANCH_RECOMMENDED` dù sub không có wildcard | Cùng cảnh báo với cả dạng sub cũ: sub theo environment không chứa tên branch. Ranh giới branch đặt ở deployment branch policy của environment `dev`/`prod` (chỉ `main`), xem bên dưới |
| Chặng 3, deploy dev #1 (CloudTrail, phiên `lab-deploy-dev-43218214696`) | Lambda `CreateFunction` (4 lần), `CreateEventSourceMapping` (4 lần) | 8 lỗi `InvalidParameterValueException`: "The role defined for the function cannot be assumed by Lambda" và "The function execution role does not have permissions to call ReceiveMessage on SQS" | **Không phải thiếu quyền của role CI**: IAM lan truyền chậm sau khi tạo execution role. Provider tự thử lại và thành công (`up` 1m24s). Không nới policy vì chúng |

Khi gặp AccessDenied thật, thêm một dòng: action thiếu, resource, vì sao cần, và commit sửa.

## Giới hạn đã biết

- **Chưa có permissions boundary.** Role deploy có `iam:PutRolePolicy` trên execution role của worker và `lambda:UpdateFunctionCode`,
  nên về nguyên tắc có thể nâng quyền trong phạm vi tên `platform-worker-*`. Cách chặn: điều kiện `iam:PermissionsBoundary`
  trên `CreateRole`/`PutRolePolicy` cộng việc worker gắn boundary. Chưa làm; chấp nhận trong sandbox một người dùng.
- **Hai statement liệt kê không giới hạn được theo tên:** `logs:DescribeLogGroups` (trên `log-group:*`) và
  `lambda:ListEventSourceMappings` (`*`). Chỉ lộ metadata, không đọc/ghi dữ liệu.
- **Event source mapping:** Get/Delete/Tag dùng UUID nên không giới hạn được theo tên (Create/Update thì có điều kiện function).
- **Environment là ranh giới, nên phải được bảo vệ.** Workflow ở branch bất kỳ tham chiếu `environment: <tên>` chưa tồn tại sẽ tự tạo
  environment không bảo vệ. Hiện: `dev` và `prod` chỉ cho deploy từ `main`; `preview` không giới hạn branch (role chỉ đọc, dùng cho PR do
  chủ repo kiểm soát); `pr-env` **đã được tạo có chủ đích** (biến `AWS_ROLE_ARN` = `lab-pr-env`) nhưng **chưa có reviewer hay branch policy**: job chạy trên PR có ref
  `refs/pull/N/merge` nên cách giới hạn phải được kiểm bằng thử nghiệm ở Chặng 4 (đến lúc đó chỉ PR tin cậy trong cùng repo).
  `prod` đã có required reviewer (xem mục cổng phê duyệt bên dưới).
- **Repo public ở tài khoản cá nhân (gói Free), từ 2026-11-12.** Trước đó repo private và API trả 403
  `Upgrade to GitHub Pro or make this repository public to enable this feature.` cho `rulesets` và `branches/main/protection`; một PR có `unit` đỏ vẫn là
  `UNSTABLE`/`MERGEABLE`. Sau khi public, ruleset dùng được và đã cấu hình **`protect-main`** (id 27118800, `active`, áp dụng cho branch mặc định):
  bắt buộc check `unit` (từ GitHub Actions) , chặn xoá `main` và chặn force-push. **Repository admin được bypass (`always`)**: chủ repo có thể push thẳng hoặc
  merge PR khi cần, nên đây là lớp bảo vệ cho PR chứ không phải ràng buộc với chủ repo. Đã kiểm: PR demo #4 có `unit` đỏ ra `mergeStateStatus: BLOCKED`
  (trước đây `UNSTABLE`). Ruleset không yêu cầu PR hay số lượt review. Merge queue vẫn không có vì chủ repo là `User`, nên trigger `merge_group`
  trong `ci.yml` **đã viết, chưa kiểm chứng queue**. Required reviewers của environment `prod` **dùng được** trên repo public gói Free (đã cấu hình và chạy ở Chặng 3).
- **Repo public: Actions log và lịch sử git là công khai.** Đã rà trước khi chuyển: lịch sử git sạch; 6/8 run đầu in account ID thật nên đã xoá, và workflow
  chuyển sang `secrets.AWS_ACCOUNT_ID` để GitHub mask. Phê duyệt workflow cho **mọi** PR từ bên ngoài đã bật (`all_external_contributors`); job `preview`
  vẫn chỉ chạy với PR cùng repo, và trust policy AWS gắn với ID repo nên fork không assume được role. Secret scanning và push protection đã bật.

## Đăng nhập Pulumi Cloud từ CI (OIDC, không có secret tĩnh)

Pulumi Cloud xác thực riêng; role AWS ở trên không đăng nhập Pulumi hộ. CI dùng **OIDC issuer của Pulumi Cloud** thay vì
`PULUMI_ACCESS_TOKEN` tĩnh:

```text
GitHub job → OIDC token (aud urn:pulumi:org:<org>) → Pulumi Cloud → access token ngắn hạn → pulumi preview
```

Workflow dùng `pulumi/auth-actions` (ghim SHA, v2.1.2): action đổi token của GitHub lấy Pulumi access token (yêu cầu 1800 giây,
server có thể giảm), tự mask và xuất `PULUMI_ACCESS_TOKEN` cho bước sau. Trong GitHub không có secret Pulumi nào; bước
`pulumi/actions` **không được** tự đặt `PULUMI_ACCESS_TOKEN` (biến rỗng sẽ ghi đè token vừa xuất).

Cấu hình một lần ở Pulumi Cloud, do chủ organization làm trên giao diện (Settings → Access Management → OIDC Issuers):

| Mục | Giá trị |
| --- | --- |
| Register issuer: Name | `github-actions` |
| Register issuer: URL | `https://token.actions.githubusercontent.com` |
| Policy: Decision | Allow |
| Policy: Token type | Personal |
| Policy: Scope | `user:x-rafael` |
| Policy: Aud | `urn:pulumi:org:x-rafael-org` |
| Policy: Sub | `repo:x-rafael@142369851/pulumi-platform-lab@1454985419:environment:preview` |

Từ Chặng 3 có thêm hai policy y hệt, chỉ khác Sub: `…:environment:dev` (deploy dev) và `…:environment:prod` (cổng prod). Chặng 4 cần thêm một policy cho `…:environment:pr-env` (Sub `repo:x-rafael@142369851/pulumi-platform-lab@1454985419:environment:pr-env`, còn lại như trên); `oidc-check.yml` đã có `pr-env` trong ma trận để kiểm sau khi thêm.

Ghi chú về policy (theo tài liệu Pulumi):

- Trong giá trị claim, `*` khớp 0 hoặc nhiều ký tự, `?` khớp 0 hoặc 1, `.` khớp đúng 1 ký tự. Sub ở trên không chứa ký tự đặc biệt nên khớp chính xác.
- Deny luôn thắng Allow; không có policy Allow nào thì bị từ chối. Mỗi environment sau này (`dev`, `prod`, `pr-env`) cần một policy riêng với sub riêng.
- Tài liệu không có ví dụ cho sub dạng environment hay dạng immutable `@ID`; giá trị trên là sub thật đã quan sát trong run OIDC của GitHub.
- Loại token: *Personal* dùng được ở mọi gói; *Organization* (Essentials, Pro, Enterprise) và *Team* (Pro, Enterprise) tuỳ gói. Chưa xác minh gói của tài khoản này.

Kiểm chứng phạm vi policy (run 43192266735, `oidc-check.yml`, cùng action và cùng input, chỉ khác sub):

- Job `environment: preview` **nhận được** token (đối chứng dương).
- Job **không có environment** (sub `…:ref:refs/heads/chang2-ci`) **bị từ chối**: `Invalid response from token exchange 401: Unauthorized (access_denied: unauthorized)`.
  Điều này loại trừ policy có sub `*` hoặc `repo:…:*`.
- **Đã kiểm ở Chặng 3:** trước khi thêm policy, job `dev` và `prod` đều bị `401 access_denied` (run 43216318729), nên policy `preview` không phải mẫu `…:environment:*`;
  sau khi thêm, cả hai nhận token (run 43218073008) và job không environment vẫn bị từ chối.
- **Chưa kiểm:** sub của `pr-env` và của repo khác. Policy do chủ org nhập trên giao diện, tôi không đọc lại được: hãy đối chiếu bảng trên với giá trị đã lưu.

Rủi ro còn lại (đã nhỏ hơn token tĩnh, nhưng không bằng không):

- Token *Personal* mang quyền của chính chủ trên **mọi stack trong `x-rafael-org`**, kể cả `platform-ci-bootstrap/lab`. Bù lại nó chỉ sống ~30 phút, chỉ cấp
  cho job khớp policy (ca âm đã kiểm, xem bên dưới), không có gì dài hạn để lộ hay xoay.
- Policy so khớp theo **environment**, không theo branch. Environment `preview` không giới hạn branch nên job ở bất kỳ branch/PR nào của repo
  tham chiếu `environment: preview` đều nhận được token. Chỉ chủ repo có quyền ghi; PR từ fork không chạy job `preview`.
  Phía AWS vẫn bị chặn bởi role `lab-preview` chỉ đọc.
- Cần Issuer + policy này còn tồn tại; gỡ policy là cắt đường đăng nhập Pulumi của CI.

## Deploy dev, chống chồng deploy và cổng phê duyệt prod

**Deploy dev** (`deploy-dev.yml`, chạy khi push vào `main` hoặc dispatch tay từ `main`): build và test, assume `lab-deploy-dev`, đăng nhập Pulumi bằng OIDC,
`preview`, `up`, rồi smoke test (gửi một message với eventId duy nhất vào queue và đợi dòng log `"status":"processed"` của đúng eventId, trần 120 giây).
Lần đầu tạo 11 resource trong 1m24s (job 156s); lần hai là no-op (`11 unchanged`, job 69s). Không đặt timeout nào để làm đẹp số đo.
Workflow cũng ghi một bảng thời gian vào job summary (chỉ thời gian, không ARN/URL); nội dung bảng đó chưa được kiểm tra. Số đo trong tài liệu này lấy từ API (`started_at`/`completed_at` của từng bước).

Lưu ý khi dùng `oidc-check.yml`: input `dev_prod_pulumi` mặc định `allowed`, và job `prod` sẽ **chờ phê duyệt** ở mỗi lần dispatch vì environment `prod` có required reviewers.

**Chống chồng deploy: hai lớp khác nhau, lớp này không thay lớp kia.**

1. `concurrency` của GitHub ở cấp job, group `deploy-platform-worker-dev`, `cancel-in-progress: false`: chỉ một run deploy dev chạy tại một thời điểm và run đang `up` không bị huỷ
   (huỷ giữa chừng có thể để lại thao tác dở). Đây **không phải hàng đợi**: run đang chờ trong group bị thay bằng run mới hơn, nên không dùng nó để đảm bảo mọi
   migration chạy theo thứ tự. Mọi workflow khác ghi stack dev phải dùng cùng group.
2. **Khoá của backend Pulumi** là lớp bảo vệ thật sự: hai `pulumi up` cùng ghi một stack bị chặn kể cả khi đến từ máy local hay workflow khác ngoài group.
   `concurrency` của GitHub không biết gì về các nguồn đó.

**Cổng phê duyệt `prod`** (`prod-preview.yml`, dispatch tay, chỉ `pulumi preview`, chưa deploy worker prod):

- Cấu hình ở Settings (API): required reviewer `x-rafael`, deployment branch chỉ `main`, `can_admins_bypass: false` (mặc định `true` cho phép chủ repo bỏ qua cổng),
  `prevent_self_review: false`. `environment: prod` trong YAML mới chỉ tham chiếu; quy tắc chặn là cấu hình environment.
- Đã thực nghiệm (run 43219292785): job đứng `waiting`, chưa gán runner, 0 bước chạy, `pending_deployments` hiện reviewer; sau khi chủ repo bấm Approve trên giao diện,
  job mới chạy: assume `lab-deploy-prod`, đổi token Pulumi, preview stack prod. Credentials chỉ được cấp sau phê duyệt.
- **Giới hạn phải nói rõ:** chỉ có một người dùng, nên đây là **owner tự phê duyệt**, không phải phê duyệt độc lập. `prevent_self_review: true` sẽ khoá chết vì run do chính
  `x-rafael` kích hoạt. Cổng chứng minh cơ chế (dừng trước credentials, cần một hành động có chủ đích), không chứng minh kiểm soát hai người.
  Chưa thử nhánh Reject và chưa thử dispatch từ branch khác `main` (job có `if: github.ref` và environment có deployment branch rule, chưa chạy thử riêng từng lớp).

**Tài nguyên còn lại sau Chặng 3:** stack dev đang chạy 11 resource thật (Lambda, 2 queue, log group, role, mapping…) để Chặng 4 dùng tiếp. Chủ sở hữu: Rafael. Chi phí gần bằng 0
khi không có traffic. Dọn ở Chặng 5; destroy bằng role CI chưa từng chạy nên dọn bằng role CI cũng là một phép thử.
