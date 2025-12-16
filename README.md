
<img width="1098" height="796" alt="Page1" src="https://github.com/user-attachments/assets/87187744-72b1-4557-b9a3-c55655f10fae" />

<img width="1098" height="796" alt="Page2" src="https://github.com/user-attachments/assets/e0285f8a-0ab7-49e8-a2ad-a17a314c0955" />

-----

## First use:
```bash
git clone https://github.com/SeoliWorks/Subscription-Manager.git
cd root_dir
npm install
sudo docker-compose up -d
npx drizzle-kit push
npm run dev
```
## Down docker:
```bash
sudo docker-compose down
```
## Next or so:
```bash
sudo docker-compose up -d
npm run dev
sudo docker-compose down
```

----

# 設計仕様書: Subscription Manager (v1.0)

## 1\. プロジェクト概要

  * **名称:** Subscription Manager
  * **目的:** 散らばりがちなサブスクリプション契約を一元管理し、固定費を可視化する。
  * **バージョン:** 1.0
  * **特徴:**
      * **APIレス:** Next.js Server Actionsによる直接的なデータ操作。
      * **End-to-End Type Safety:** DBからフロントエンドまで完全な型安全性を提供。
      * **Multi-currency Support:** JPY, USD, EUR の個別集計と表示に対応。
      * **Robust UX:** Optimistic UI、Suspense Loading、およびタイムゾーンを考慮した日付管理。

## 2\. 技術スタック (Tech Stack)

| カテゴリ | 技術選定 | 役割 | 備考 |
| :--- | :--- | :--- | :--- |
| **Framework** | **Next.js 15 (App Router)** | フルスタックFW | Server Actions / Suspense / Optimistic UI |
| **Language** | **TypeScript** | 言語 | Strict Mode |
| **Styling** | **Tailwind CSS** | スタイリング | |
| **UI Library** | **shadcn/ui** | コンポーネント | Dialog, Table, Alert Dialog, Select, Skeleton |
| **Feedback** | **Sonner** | 通知 (Toast) | ノンブロッキングなUX |
| **Database** | **PostgreSQL** | RDB | `postgres` (client) |
| **ORM** | **Drizzle ORM** | DB操作 | `drizzle-kit` によるマイグレーション |
| **Validation** | **Zod** | スキーマ検証 | `z.coerce` による型変換含む |

## 3\. アプリケーション・アーキテクチャ

### 3.1 ディレクトリ構造 (v1.0)

```text
app/
 ├── actions.ts                  # Server Actions (DB操作・認証・検証・セキュリティ対策済)
 ├── loading.tsx                 # Loading UI (Skeleton / Suspense fallback)
 ├── page.tsx                    # メイン画面 (Server Component / 多通貨集計)
 └── _components/                # プレゼンテーション層
      ├── add-subscription-button.tsx  # 追加モーダル (Client / Safe Date Init)
      └── subscription-list.tsx        # 一覧リスト (Client / Typed Optimistic UI)
db/
 ├── index.ts                    # DB接続クライアント (Singleton / Env Check)
 └── schema.ts                   # Drizzleスキーマ & 型定義
lib/
 ├── constants.ts                # 定数定義 (Currency, Cycle, Labels)
 ├── utils.ts                    # 純粋関数 (集計ロジック, 通貨変換, 日付計算)
 └── validations.ts              # Zodスキーマ (Form Validation)
```

### 3.2 データフロー & セキュリティ

  * **Server Actions:**
      * クライアントから `path` 引数を受け取る設計を廃止し、内部で `revalidatePath('/')` を固定実行。
      * バリデーションエラー時は `fieldErrors` を返却し、UI上の各入力項目へ詳細なフィードバックを行う。
  * **Optimistic UI:**
      * `useOptimistic` を使用し、サーバー応答を待たずにリストを即時更新。
      * 失敗時はToast通知と共に自動的にロールバック（Reactの標準挙動）。

## 4\. データベース設計

**テーブル名:** `subscriptions`

| カラム名 | 型 | 制約/Default | 説明 |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PK, Default Random | - |
| `user_id` | Text | Not Null | 所有者ID (Indexあり) |
| `name` | Text | Not Null | サービス名 |
| `price` | Integer | Not Null | **通貨の最小単位** (例: 100円=100, $10.99=1099) |
| `currency` | Text | Default: 'JPY' | `JPY`, `USD`, `EUR` (拡張可能) |
| `cycle` | Text | Not Null | `monthly` / `yearly` |
| `next_payment` | Date | Not Null | YYYY-MM-DD |
| `category` | Text | Default: 'general' | - |
| `is_active` | Boolean | Default: true | - |
| `created_at` | Timestamp | Default Now | - |
| `updated_at` | Timestamp | Default Now | 更新日時 |

## 5\. ロジック & ビジネスルール

### 5.1 通貨・金額計算 (Minor Units Handling)

1.  **DB保存 (Write):**
      * IEEE 754 浮動小数点誤差を防ぐため、文字列操作により小数点を移動させ整数化 (`10.99` -\> `1099`) して保存。
2.  **集計 (Aggregation):**
      * `calculateMonthlyAggregations` 関数により、通貨ごとに個別に集計。
      * 年額プランの月割り計算時に発生する端数は、項目ごとに厳密な丸め処理を行う。
3.  **表示 (Read):**
      * **DB値の表示:** `formatCurrency` (DB整数 -\> 表示文字列)
      * **集計値の表示:** `formatDisplayPrice` (実数 -\> 表示文字列)

### 5.2 日付管理 (Timezone Safe)

  * **サーバーサイド (SSR):** タイムゾーン依存のリスクがあるため、現在時刻によるデフォルト値生成を行わない。
  * **クライアントサイド (CSR):** `add-subscription-button.tsx` 内で `getLocalTodayString()` を使用し、ユーザーのブラウザロケールに基づいた「今日」を初期値として設定。
  * **Hydration Mismatch対策:** 日付生成ロジックを分離し、サーバー/クライアント間の不整合を防ぐ。

### 5.3 バリデーション

  * **型安全性:** `SubscriptionPublic` 型を定義・エクスポートし、フロントエンドコンポーネントで `any` の使用を禁止。
  * **入力制限:**
      * Price: 0.01以上。
      * Date: 2000年以降かつ、無効な日付文字列を拒否。

## 6\. セキュリティ設計 (Updated)

  * **所有者検証:**
      * 全ての CRUD 操作において `WHERE user_id = current_user.id` を強制。
  * **Revalidation保護:**
      * `revalidatePath` の引数をサーバー側で固定化。
  * **Fail Fast:**
      * 環境変数 (`DATABASE_URL`) 未設定時は起動時にクラッシュさせ、設定ミスを即座に検知。

## 7\. 今後の拡張ロードマップ

基盤修正により、以下の機能拡張が容易になっています。

1.  **認証機能の完全統合 (Clerk / Auth.js)**
      * `actions.ts` の `getCurrentUser` モックを差し替えるのみで完了。
2.  **為替レート連携**
      * 現在は通貨ごとの小計表示（`USD: $20.00`）まで実装済み。
      * 外部API (Exchange Rate API) を導入すれば、`calculateMonthlyAggregations` 内で円換算総額を算出可能。
3.  **カテゴリ別チャート**
      * データ構造は整っているため、`recharts` 等を導入して `category` ごとの円グラフ描画が可能。

-----
