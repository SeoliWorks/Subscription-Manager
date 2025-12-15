
-----

### ディレクトリ構造 (最終版)

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

#### 1\. ユーティリティ & 定義 (`lib/`)

**`lib/constants.ts`**

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

**`lib/utils.ts`** (通貨フォーマット機能を追加)

```typescript
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { type Subscription } from "@/db/schema"
import { SUBSCRIPTION_CYCLES, CURRENCIES } from "./constants"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// クライアント/サーバー共通で使える「今日」の日付文字列 (YYYY-MM-DD)
export function getLocalTodayString(): string {
  // 'sv-SE' ロケールは ISO 8601 (YYYY-MM-DD) 形式と互換性がある
  return new Date().toLocaleDateString('sv-SE');
}

/**
 * 通貨を見やすくフォーマットする
 * @param price 金額
 * @param currency 通貨コード (JPY, USD, etc.)
 */
export function formatCurrency(price: number, currency: string): string {
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: currency,
    // JPYの場合は小数を表示しない、USD等は必要に応じて表示などの調整が自動で行われる
  }).format(price);
}

/**
 * 指定通貨での月額換算合計を計算
 * - 異なる通貨は計算対象外
 * - 年額は12で割り、切り上げ (予算オーバーを防ぐ安全策)
 */
export function calculateMonthlyTotal(
  subscriptions: Subscription[], 
  targetCurrency: string = CURRENCIES.JPY
): number {
  return subscriptions
    .filter(sub => sub.currency === targetCurrency)
    .reduce((acc, curr) => {
      if (curr.cycle === SUBSCRIPTION_CYCLES.yearly) {
        return acc + Math.ceil(curr.price / 12);
      }
      return acc + curr.price;
    }, 0);
}
```

**`lib/validations.ts`** (バリデーション定義)

```typescript
import { z } from 'zod';
import { SUBSCRIPTION_CYCLES } from '@/lib/constants';

export const formSchema = z.object({
  name: z.string().min(1, 'サービス名は必須です'),
  price: z.coerce.number().min(1, '金額を入力してください').nonnegative('マイナスの金額は入力できません'),
  cycle: z.enum([SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly], {
    required_error: '支払いサイクルを選択してください',
  }),
  nextPayment: z.string().date().refine((val) => {
    // 簡易チェック: 空文字でないこと。
    // 厳密な未来日付チェックはタイムゾーン問題があるため、UIのmin属性に任せる
    return val.length > 0;
  }, '日付を入力してください'),
  category: z.string().optional(),
});

export type FormValues = z.infer<typeof formSchema>;
```

-----

#### 2\. データベース設定 (`db/`)

**`db/index.ts`** (シングルトン接続: 開発環境でのクラッシュ防止)

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// Next.jsのHot Reload対策: グローバルに接続をキャッシュ
const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const client = globalForDb.conn ?? postgres(connectionString, { 
  max: 10, // 接続プールの上限設定
});

if (process.env.NODE_ENV !== 'production') {
  globalForDb.conn = client;
}

export const db = drizzle(client, { schema });
```

**`db/schema.ts`**

```typescript
import { pgTable, text, integer, boolean, timestamp, uuid, date } from 'drizzle-orm/pg-core';
import { type InferSelectModel, type InferInsertModel } from 'drizzle-orm';
import { SUBSCRIPTION_CYCLES, CURRENCIES } from '@/lib/constants';

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(), // Auth ID
  
  name: text('name').notNull(),
  price: integer('price').notNull(),
  currency: text('currency').default(CURRENCIES.JPY).notNull(),
  
  cycle: text('cycle', { enum: [SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly] }).notNull(),
  nextPayment: date('next_payment').notNull(),
  
  category: text('category').default('general'),
  isActive: boolean('is_active').default(true).notNull(),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;
```

-----

#### 3\. サーバーアクション (`app/actions.ts`)

**`app/actions.ts`** (Auth抽象化とデータ隠蔽の実装)

```typescript
'use server';

import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { formSchema, type FormValues } from '@/lib/validations';
import { eq, desc, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

// --- 認証レイヤーの抽象化 ---
// 将来 Auth.js や Clerk を導入する際は、この関数の中身だけを書き換えればOK
async function getCurrentUser() {
  // TODO: Replace with actual auth logic, e.g., await auth();
  return { id: 'user_demo_123' };
}
// -------------------------

export type ActionResponse<T = null> = {
  success: boolean;
  data?: T;
  error?: string;
};

// フロントエンドに公開して良いデータの型 (userIdなどの機密情報を除外)
type SubscriptionPublic = Omit<typeof subscriptions.$inferSelect, 'userId' | 'createdAt'>;

export async function getSubscriptions(): Promise<ActionResponse<SubscriptionPublic[]>> {
  try {
    const user = await getCurrentUser();
    
    const data = await db.query.subscriptions.findMany({
      where: eq(subscriptions.userId, user.id),
      orderBy: [desc(subscriptions.nextPayment)],
      // 必要なカラムのみを明示的に取得 (Data Masking)
      columns: {
        id: true,
        name: true,
        price: true,
        currency: true,
        cycle: true,
        nextPayment: true,
        category: true,
        isActive: true,
      }
    });
    return { success: true, data };
  } catch (error) {
    console.error('Failed to fetch subscriptions:', error);
    return { success: false, error: 'データの取得に失敗しました', data: [] };
  }
}

export async function addSubscription(data: FormValues): Promise<ActionResponse> {
  const validated = formSchema.safeParse(data);
  if (!validated.success) {
    return { success: false, error: '入力内容に誤りがあります' };
  }

  try {
    const user = await getCurrentUser();
    
    await db.insert(subscriptions).values({
      ...validated.data,
      userId: user.id, // 取得したユーザーIDを使用
    });

    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Failed to add subscription:', error);
    return { success: false, error: 'データベースへの保存に失敗しました' };
  }
}

export async function deleteSubscription(id: string): Promise<ActionResponse> {
  try {
    const user = await getCurrentUser();

    const result = await db.delete(subscriptions)
      .where(
        and(
          eq(subscriptions.id, id),
          eq(subscriptions.userId, user.id) // 所有権確認
        )
      )
      .returning({ deletedId: subscriptions.id });

    if (result.length === 0) {
      return { success: false, error: '削除対象が見つからないか、権限がありません' };
    }
    
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Failed to delete subscription:', error);
    return { success: false, error: '削除処理中にエラーが発生しました' };
  }
}
```

-----

#### 4\. UIコンポーネント (`app/_components/`)

**`app/_components/add-subscription-button.tsx`**

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
import { Plus, Loader2 } from 'lucide-react';

export function AddSubscriptionButton() {
  const [open, setOpen] = useState(false);
  
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      price: 0,
      cycle: SUBSCRIPTION_CYCLES.monthly,
      nextPayment: getLocalTodayString(),
    },
  });

  const isSubmitting = form.formState.isSubmitting;

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
                  <FormControl>
                    <Input 
                      type="date" 
                      {...field} 
                      // 過去の日付入力を防ぐ (UX向上)
                      min={getLocalTodayString()}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  保存中...
                </>
              ) : (
                '保存'
              )}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**`app/_components/subscription-list.tsx`**

```tsx
'use client';

import { useOptimistic, startTransition, useState } from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { type Subscription } from '@/db/schema';
import { CYCLE_LABELS, SUBSCRIPTION_CYCLES } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils'; // 共通フォーマッター
import { deleteSubscription } from '@/app/actions';

// 行コンポーネント
function SubscriptionRow({ 
  sub, 
  onDeleteClick 
}: { 
  sub: Partial<Subscription> & Pick<Subscription, 'id' | 'name' | 'price' | 'currency' | 'cycle' | 'nextPayment'>, 
  onDeleteClick: (id: string, name: string) => void 
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">{sub.name}</TableCell>
      <TableCell>{formatCurrency(sub.price, sub.currency)}</TableCell>
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
          onClick={() => onDeleteClick(sub.id, sub.name)}
          aria-label={`${sub.name}を削除`} // アクセシビリティ対応
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function SubscriptionList({ initialData }: { initialData: any[] }) {
  // Optimistic UI
  const [optimisticSubscriptions, mutateOptimisticSubscriptions] = useOptimistic(
    initialData,
    (state, idToDelete: string) => state.filter((sub) => sub.id !== idToDelete)
  );

  const [deleteTarget, setDeleteTarget] = useState<{ id: string, name: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const executeDelete = async () => {
    if (!deleteTarget) return;

    setIsDeleting(true);

    startTransition(() => {
      mutateOptimisticSubscriptions(deleteTarget.id);
    });

    const result = await deleteSubscription(deleteTarget.id);

    setIsDeleting(false);
    setDeleteTarget(null);

    if (result.success) {
      toast.success('削除しました');
    } else {
      toast.error(result.error || '削除に失敗しました');
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
    <>
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
              onDeleteClick={(id, name) => setDeleteTarget({ id, name })} 
            />
          ))}
        </TableBody>
      </Table>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>本当に削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」の情報を完全に削除します。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction 
              onClick={(e) => {
                e.preventDefault();
                executeDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isDeleting}
            >
              {isDeleting ? '削除中...' : '削除する'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

-----

#### 5\. ダッシュボード (`app/page.tsx`)

**`app/page.tsx`**

```tsx
import { getSubscriptions } from './actions';
import { SubscriptionList } from './_components/subscription-list';
import { AddSubscriptionButton } from './_components/add-subscription-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { JapaneseYen, CreditCard, AlertCircle } from 'lucide-react';
import { calculateMonthlyTotal, formatCurrency } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default async function DashboardPage() {
  const { success, data, error } = await getSubscriptions();

  if (!success || !data) {
    return (
      <div className="container mx-auto py-10 space-y-8">
        <h1 className="text-3xl font-bold tracking-tight">サブスク管理</h1>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>エラー</AlertTitle>
          <AlertDescription>{error || 'データの読み込みに失敗しました。'}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // JPYのみを計算
  const totalMonthly = calculateMonthlyTotal(data, 'JPY');

  return (
    <div className="container mx-auto py-10 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">サブスク管理</h1>
        <AddSubscriptionButton />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">月額固定費 (JPY)</CardTitle>
            <JapaneseYen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {/* 共通フォーマッターを利用 */}
            <div className="text-2xl font-bold">{formatCurrency(totalMonthly, 'JPY')}</div>
            <p className="text-xs text-muted-foreground mt-1">
              ※年額プランは月割り(切り上げ) / 外貨建ては除外
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

-----
