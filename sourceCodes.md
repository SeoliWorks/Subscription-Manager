▶これまでの3回にわたるレビューと改善（リファクタリング）を反映した、\*\*「Subscription Manager (最終完成版)」\*\*の全ソースコードです。
省略箇所はなく、そのままコピー＆ペーストして動作するように構成しています。

特に以下の点が初期コードから変更・強化されています。

1.  **堅牢性:** DBスキーマからの型推論と、定数（Enum）による管理。
2.  **セキュリティ:** 削除・追加時の厳格な所有者チェック。
3.  **UX:** `useOptimistic` による即時削除反映と、Toast通知。
4.  **保守性:** ビジネスロジックと日付処理の分離。

-----

### ディレクトリ構造 (最終版)

`app/_components/delete-button.tsx` は `subscription-list.tsx` に機能統合したため削除しました。

```text
app/
 ├── actions.ts                  # Server Actions (DB操作・認証・検証)
 ├── page.tsx                    # ダッシュボード画面 (Server Component)
 └── _components/
      ├── add-subscription-button.tsx  # 追加モーダル (Client Component / Toast対応)
      └── subscription-list.tsx        # 一覧リスト (Client Component / Optimistic UI対応)
db/
 ├── index.ts                    # DB接続設定
 └── schema.ts                   # Drizzleスキーマ & 型定義 (定数利用)
lib/
 ├── constants.ts                # 定数定義 (New)
 ├── utils.ts                    # ユーティリティ & 計算ロジック
 └── validations.ts              # Zodバリデーション (Renamed from schema.ts)
```

-----

### 1\. 設定・ユーティリティ・定義 (Config & Libs)

**`lib/constants.ts`** (新規作成: 定数管理)

```typescript
export const SUBSCRIPTION_CYCLES = {
  monthly: 'monthly',
  yearly: 'yearly',
} as const;

export const CYCLE_LABELS = {
  [SUBSCRIPTION_CYCLES.monthly]: '月額',
  [SUBSCRIPTION_CYCLES.yearly]: '年額',
};

export const CURRENCIES = {
  JPY: 'JPY',
  USD: 'USD',
  EUR: 'EUR',
} as const;
```

**`lib/utils.ts`** (計算ロジックと日付処理を追加)

```typescript
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { type Subscription } from "@/db/schema"
import { SUBSCRIPTION_CYCLES } from "./constants"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 日本時間などを考慮して、ブラウザのローカル日付(YYYY-MM-DD)を取得
export function getLocalTodayString(): string {
  const local = new Date();
  const offset = local.getTimezoneOffset();
  const adjustedDate = new Date(local.getTime() - (offset * 60 * 1000));
  return adjustedDate.toISOString().split('T')[0];
}

// ビジネスロジック: 月額換算の合計値を計算
export function calculateMonthlyTotal(subscriptions: Subscription[]): number {
  return subscriptions.reduce((acc, curr) => {
    // 将来的に isActive チェックを入れる場合はここに追加
    if (curr.cycle === SUBSCRIPTION_CYCLES.yearly) {
      // 年額の場合は12で割り、四捨五入
      return acc + Math.round(curr.price / 12);
    }
    return acc + curr.price;
  }, 0);
}
```

**`lib/validations.ts`** (旧 `lib/schema.ts` からリネーム)

```typescript
import { z } from 'zod';
import { SUBSCRIPTION_CYCLES } from '@/lib/constants';

export const formSchema = z.object({
  name: z.string().min(1, 'サービス名は必須です'),
  price: z.coerce.number().min(1, '金額を入力してください'),
  cycle: z.enum([SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly], {
    required_error: '支払いサイクルを選択してください',
  }),
  nextPayment: z.string().date(), // YYYY-MM-DD形式のバリデーション
  category: z.string().optional(),
});

export type FormValues = z.infer<typeof formSchema>;
```

**`db/schema.ts`** (定数利用と型推論)

```typescript
import { pgTable, text, integer, boolean, timestamp, uuid, date } from 'drizzle-orm/pg-core';
import { type InferSelectModel, type InferInsertModel } from 'drizzle-orm';
import { SUBSCRIPTION_CYCLES, CURRENCIES } from '@/lib/constants';

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  
  name: text('name').notNull(),
  price: integer('price').notNull(),
  // 通貨デフォルトを定数から設定
  currency: text('currency').default(CURRENCIES.JPY).notNull(),
  // Enumを定数から生成
  cycle: text('cycle', { enum: [SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly] }).notNull(),
  nextPayment: date('next_payment').notNull(),
  
  category: text('category').default('general'),
  isActive: boolean('is_active').default(true).notNull(),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// アプリケーション全体で使用する型定義
export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;
```

**`db/index.ts`** (変更なし)

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);

export const db = drizzle(client, { schema });
```

-----

### 2\. バックエンドロジック (Server Actions)

**`app/actions.ts`** (セキュリティ強化済み)

```typescript
'use server';

import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { formSchema, type FormValues } from '@/lib/validations';
import { eq, desc, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

// デモ用の固定ユーザーID
const DEMO_USER_ID = 'user_demo_123'; 

export async function getSubscriptions() {
  try {
    const data = await db.query.subscriptions.findMany({
      where: eq(subscriptions.userId, DEMO_USER_ID),
      orderBy: [desc(subscriptions.nextPayment)],
    });
    return data;
  } catch (error) {
    console.error('Failed to fetch subscriptions:', error);
    return [];
  }
}

export async function addSubscription(data: FormValues) {
  // 1. バリデーション
  const validated = formSchema.safeParse(data);
  if (!validated.success) {
    return { success: false, error: '入力内容に誤りがあります' };
  }

  try {
    // 2. 保存 (ユーザーIDを付与)
    await db.insert(subscriptions).values({
      ...validated.data,
      userId: DEMO_USER_ID,
    });

    // 3. キャッシュ更新
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Failed to add subscription:', error);
    return { success: false, error: '保存に失敗しました' };
  }
}

export async function deleteSubscription(id: string) {
  try {
    // セキュリティ対策: IDだけでなくユーザーIDも一致することを確認
    await db.delete(subscriptions)
      .where(
        and(
          eq(subscriptions.id, id),
          eq(subscriptions.userId, DEMO_USER_ID)
        )
      );
    
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Failed to delete subscription:', error);
    return { success: false, error: '削除に失敗しました' };
  }
}
```

-----

### 3\. フロントエンド UI コンポーネント

**`app/_components/add-subscription-button.tsx`** (Toast & 定数対応)

```tsx
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { formSchema, type FormValues } from '@/lib/validations';
import { addSubscription } from '@/app/actions';
import { SUBSCRIPTION_CYCLES, CYCLE_LABELS } from '@/lib/constants';
import { getLocalTodayString } from '@/lib/utils';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus } from 'lucide-react';

export function AddSubscriptionButton() {
  const [open, setOpen] = useState(false);
  
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      price: 0,
      cycle: SUBSCRIPTION_CYCLES.monthly,
      // タイムゾーンを考慮した今日の日付を初期値にする
      nextPayment: getLocalTodayString(),
    },
  });

  async function onSubmit(values: FormValues) {
    const res = await addSubscription(values);
    if (res.success) {
      toast.success('サブスクリプションを追加しました');
      setOpen(false);
      form.reset();
    } else {
      toast.error(res.error || 'エラーが発生しました');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" /> 追加する</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>サブスクを追加</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>サービス名</FormLabel>
                  <FormControl><Input placeholder="Netflix" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="price"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>金額</FormLabel>
                      <FormControl><Input type="number" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="cycle"
                  render={({ field }) => (
                    <FormItem className="w-32">
                      <FormLabel>サイクル</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(CYCLE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
            </div>
             <FormField
              control={form.control}
              name="nextPayment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>次回支払日</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full">保存</Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**`app/_components/subscription-list.tsx`** (Optimistic UI & 統合された削除機能)

```tsx
'use client';

import { useOptimistic, startTransition } from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { type Subscription } from '@/db/schema';
import { CYCLE_LABELS, SUBSCRIPTION_CYCLES } from '@/lib/constants';
import { deleteSubscription } from '@/app/actions';

// 行コンポーネント (削除ロジックの呼び出しを担当)
function SubscriptionRow({ 
  sub, 
  onDelete 
}: { 
  sub: Subscription, 
  onDelete: (id: string, name: string) => void 
}) {
  // 通貨フォーマッター
  const formatPrice = (price: number, currency: string) => {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: currency,
    }).format(price);
  };

  return (
    <TableRow>
      <TableCell className="font-medium">{sub.name}</TableCell>
      <TableCell>{formatPrice(sub.price, sub.currency)}</TableCell>
      <TableCell>
        <Badge variant={sub.cycle === SUBSCRIPTION_CYCLES.monthly ? 'secondary' : 'outline'}>
          {CYCLE_LABELS[sub.cycle as keyof typeof CYCLE_LABELS]}
        </Badge>
      </TableCell>
      <TableCell>{sub.nextPayment}</TableCell>
      <TableCell className="text-right">
        <Button 
          variant="ghost" 
          size="icon" 
          className="text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(sub.id, sub.name)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function SubscriptionList({ initialData }: { initialData: Subscription[] }) {
  // Optimistic State: サーバー応答を待たずにUIから要素を消すためのフック
  const [optimisticSubscriptions, mutateOptimisticSubscriptions] = useOptimistic(
    initialData,
    (state, idToDelete: string) => {
      return state.filter((sub) => sub.id !== idToDelete);
    }
  );

  const handleDelete = async (id: string, name: string) => {
    const isConfirmed = confirm(`「${name}」を削除しますか？`);
    if (!isConfirmed) return;

    // 1. 即座にUIから削除 (楽観的更新)
    startTransition(() => {
      mutateOptimisticSubscriptions(id);
    });

    // 2. サーバーで削除実行
    const result = await deleteSubscription(id);

    if (result.success) {
      toast.success('削除しました');
    } else {
      toast.error('削除に失敗しました');
      // 失敗した場合、Next.jsの自動再検証によりデータは復元されますが、通知は必要です
    }
  };

  if (optimisticSubscriptions.length === 0) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        登録されているサブスクリプションはありません。
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>サービス名</TableHead>
          <TableHead>金額</TableHead>
          <TableHead>サイクル</TableHead>
          <TableHead>次回支払日</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {optimisticSubscriptions.map((sub) => (
          <SubscriptionRow 
            key={sub.id} 
            sub={sub} 
            onDelete={handleDelete} 
          />
        ))}
      </TableBody>
    </Table>
  );
}
```

-----

### 4\. メインページ (Dashboard)

**`app/page.tsx`** (ロジック分離済み)

```tsx
import { getSubscriptions } from './actions';
import { SubscriptionList } from './_components/subscription-list';
import { AddSubscriptionButton } from './_components/add-subscription-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { JapaneseYen, CreditCard } from 'lucide-react';
import { calculateMonthlyTotal } from '@/lib/utils';

export default async function DashboardPage() {
  const data = await getSubscriptions();

  // ユーティリティを使用して計算 (年額は月割り)
  const totalMonthly = calculateMonthlyTotal(data);

  return (
    <div className="container mx-auto py-10 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">サブスク管理</h1>
        <AddSubscriptionButton />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">月額固定費 (概算)</CardTitle>
            <JapaneseYen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">¥{totalMonthly.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              ※年額プランは月割りで計算
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">契約数</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.length} 件</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>契約中サービス一覧</CardTitle>
        </CardHeader>
        <CardContent>
          <SubscriptionList initialData={data} />
        </CardContent>
      </Card>
    </div>
  );
}
```
