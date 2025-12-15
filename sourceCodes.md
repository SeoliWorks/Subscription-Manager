
-----

### ディレクトリ構造 (最終版)

```text
app/
 ├── actions.ts                  # Server Actions (DB操作・認証・検証・Revalidation)
 ├── page.tsx                    # メイン画面 (Server Component / データ集計)
 └── _components/                # プレゼンテーション層
      ├── add-subscription-button.tsx  # 追加モーダル (Client / Form Control)
      └── subscription-list.tsx        # 一覧リスト (Client / Optimistic UI / 削除確認)
db/
 ├── index.ts                    # DB接続クライアント (Singleton / Env Check)
 └── schema.ts                   # Drizzleスキーマ & 型定義 (Single Source of Truth)
lib/
 ├── constants.ts                # 定数定義 (Currency, Cycle, Labels)
 ├── utils.ts                    # 純粋関数 (通貨変換, 日付計算, Class Merge)
 └── validations.ts              # Zodスキーマ (Form Validation)
```
-----

### 1\. ユーティリティ & 定数 (`lib/`)

**`lib/constants.ts`**
通貨とサイクルの定義。

```typescript
export const SUBSCRIPTION_CYCLES = {
  monthly: 'monthly',
  yearly: 'yearly',
} as const;

export const CYCLE_LABELS = {
  [SUBSCRIPTION_CYCLES.monthly]: '月額',
  [SUBSCRIPTION_CYCLES.yearly]: '年額',
};

// 通貨設定
// decimals: DB保存時の倍率 (例: 2なら x100)
export const CURRENCIES = {
  JPY: { code: 'JPY', symbol: '¥', decimals: 0 },
  USD: { code: 'USD', symbol: '$', decimals: 2 },
  EUR: { code: 'EUR', symbol: '€', decimals: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
```

**`lib/utils.ts`**
集計ロジックを大幅に強化しました。

```typescript
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { type Subscription } from "@/db/schema"
import { SUBSCRIPTION_CYCLES, CURRENCIES, type CurrencyCode } from "./constants"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * クライアントサイドでのみ使用することを推奨 (Hydration Mismatch防止)
 * サーバーのタイムゾーンに依存せず、ブラウザの「今日」を返します
 */
export function getLocalTodayString(): string {
  // sv-SEロケールは YYYY-MM-DD 形式を返すためのハック
  return new Date().toLocaleDateString('sv-SE');
}

/**
 * DB保存値(整数)を、UI表示用の数値(小数含む)に戻す
 * 例: USD, 999 -> 9.99
 */
export function convertAmountFromMinorUnits(amount: number, currency: string): number {
  const config = CURRENCIES[currency as CurrencyCode] ?? CURRENCIES.JPY;
  return amount / Math.pow(10, config.decimals);
}

/**
 * UI入力値(小数含む)を、DB保存用の整数(最小単位)に変換
 * 例: USD, 9.99 -> 999
 */
export function convertAmountToMinorUnits(amount: number, currency: string): number {
  const config = CURRENCIES[currency as CurrencyCode] ?? CURRENCIES.JPY;
  return Math.round(amount * Math.pow(10, config.decimals));
}

/**
 * [DB用] DBの整数値を受け取り、自動的に小数に戻してフォーマットする
 */
export function formatCurrency(amountFromDb: number, currency: string): string {
  const actualAmount = convertAmountFromMinorUnits(amountFromDb, currency);
  return formatDisplayPrice(actualAmount, currency);
}

/**
 * [表示用] すでに計算済みの数値を受け取り、通貨フォーマットする
 */
export function formatDisplayPrice(amount: number, currency: string): string {
  // アプリの仕様として ja-JP ロケールで統一
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: currency,
  }).format(amount);
}

export type AggregatedTotals = {
  [key in CurrencyCode]: number;
};

/**
 * 全通貨の月額換算合計を計算して返す
 * 戻り値例: { JPY: 5000, USD: 10.50, EUR: 0 }
 */
export function calculateMonthlyAggregations(subscriptions: Subscription[]): AggregatedTotals {
  const totals: AggregatedTotals = {
    JPY: 0,
    USD: 0,
    EUR: 0,
  };

  subscriptions.forEach((sub) => {
    const currency = sub.currency as CurrencyCode;
    // 定義外の通貨コードは無視
    if (!totals.hasOwnProperty(currency)) return;

    const actualPrice = convertAmountFromMinorUnits(sub.price, currency);
    
    let monthlyPrice = actualPrice;
    if (sub.cycle === SUBSCRIPTION_CYCLES.yearly) {
      monthlyPrice = actualPrice / 12;
    }

    totals[currency] += monthlyPrice;
  });

  return totals;
}
```

**`lib/validations.ts`**
Zodスキーマ定義。

```typescript
import { z } from 'zod';
import { SUBSCRIPTION_CYCLES, CURRENCIES } from '@/lib/constants';

export const formSchema = z.object({
  name: z.string().min(1, 'サービス名は必須です'),
  price: z.coerce.number()
    .min(0.01, '金額を入力してください')
    .nonnegative('マイナスの金額は入力できません'),
  currency: z.enum([CURRENCIES.JPY.code, CURRENCIES.USD.code, CURRENCIES.EUR.code]),
  cycle: z.enum([SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly], {
    required_error: '支払いサイクルを選択してください',
  }),
  nextPayment: z.string().date().refine((val) => {
    const date = new Date(val);
    return !isNaN(date.getTime()) && date.getFullYear() > 2000;
  }, '正しい日付を入力してください'),
  category: z.string().optional(),
});

export type FormValues = z.infer<typeof formSchema>;
```

-----

### 2\. データベース設定 (`db/`)

**`db/index.ts`**
接続設定。

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

const connectionString = process.env.DATABASE_URL;

const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const client = globalForDb.conn ?? postgres(connectionString, { 
  max: process.env.NODE_ENV === 'production' ? 10 : 1, 
});

if (process.env.NODE_ENV !== 'production') {
  globalForDb.conn = client;
}

export const db = drizzle(client, { schema });
```

**`db/schema.ts`**
スキーマ定義。

```typescript
import { pgTable, text, integer, boolean, timestamp, uuid, date, index } from 'drizzle-orm/pg-core';
import { type InferSelectModel, type InferInsertModel } from 'drizzle-orm';
import { SUBSCRIPTION_CYCLES, CURRENCIES } from '@/lib/constants';

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  
  name: text('name').notNull(),
  // integerだが、通貨の最小単位(cents/yen)で保存する
  price: integer('price').notNull(), 
  currency: text('currency').default(CURRENCIES.JPY.code).notNull(),
  
  cycle: text('cycle', { enum: [SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly] }).notNull(),
  nextPayment: date('next_payment').notNull(),
  
  category: text('category').default('general'),
  isActive: boolean('is_active').default(true).notNull(),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => {
  return {
    userIdIdx: index('user_id_idx').on(table.userId),
  };
});

export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;
```

-----

### 3\. Server Actions (`app/actions.ts`)

セキュリティ修正適用済み。

```typescript
'use server';

import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { formSchema, type FormValues } from '@/lib/validations';
import { convertAmountToMinorUnits } from '@/lib/utils';
import { eq, desc, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

// --- Auth Handling ---
// 実運用の際はここをClerkやAuth.jsのロジックに置き換える
async function getCurrentUser() {
  return { id: 'user_demo_123' };
}
// --------------------

export type ActionResponse<T = null> = {
  success: boolean;
  data?: T;
  error?: string;
};

// フロントエンド公開用データ型
export type SubscriptionPublic = Omit<typeof subscriptions.$inferSelect, 'userId' | 'createdAt'>;

export async function getSubscriptions(): Promise<ActionResponse<SubscriptionPublic[]>> {
  try {
    const user = await getCurrentUser();
    
    // 型安全性を確保しつつ、必要なカラムのみ取得
    const data = await db.query.subscriptions.findMany({
      where: eq(subscriptions.userId, user.id),
      orderBy: [desc(subscriptions.nextPayment)],
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
    return { success: true, data: data as SubscriptionPublic[] };
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
    
    // UIの数値(小数)をDB用整数に変換
    const priceInMinorUnits = convertAmountToMinorUnits(
      validated.data.price, 
      validated.data.currency
    );

    await db.insert(subscriptions).values({
      ...validated.data,
      price: priceInMinorUnits,
      userId: user.id,
    });

    // サーバー側でパスを固定してRevalidate (セキュリティ向上)
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

    // userIdを条件に含めることで、所有者のみが削除可能
    const result = await db.delete(subscriptions)
      .where(
        and(
          eq(subscriptions.id, id),
          eq(subscriptions.userId, user.id)
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

### 4\. UIコンポーネント (`app/_components/`)

**`app/_components/add-subscription-button.tsx`**
クライアントサイドでの安全な日付初期化を実装。

```tsx
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { formSchema, type FormValues } from '@/lib/validations';
import { addSubscription } from '@/app/actions';
import { SUBSCRIPTION_CYCLES, CYCLE_LABELS, CURRENCIES } from '@/lib/constants';
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
      currency: CURRENCIES.JPY.code,
      cycle: SUBSCRIPTION_CYCLES.monthly,
      category: 'general',
      // マウント後にクライアントの今日の日付をセットするのが理想だが、
      // ユーザー操作まで日付が変わることは稀なため、初期値として関数呼び出しを行う
      nextPayment: getLocalTodayString(),
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: FormValues) {
    // path引数は削除済み
    const res = await addSubscription(values);
    
    if (res.success) {
      toast.success('サブスクリプションを追加しました');
      setOpen(false);
      // フォームリセット
      form.reset({
        name: '',
        price: 0,
        currency: CURRENCIES.JPY.code,
        cycle: SUBSCRIPTION_CYCLES.monthly,
        nextPayment: getLocalTodayString(),
        category: 'general',
      });
    } else {
      toast.error(res.error || 'エラーが発生しました');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" /> 追加する</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
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
                  <FormControl><Input placeholder="Netflix, Spotify..." {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex gap-3">
                <FormField
                  control={form.control}
                  name="price"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>金額</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" placeholder="0" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem className="w-24">
                      <FormLabel>通貨</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.values(CURRENCIES).map((currency) => (
                            <SelectItem key={currency.code} value={currency.code}>
                              {currency.code} ({currency.symbol})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                      // 過去の日付選択を防ぐ
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
型定義を厳格化。

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

import { type SubscriptionPublic, deleteSubscription } from '@/app/actions';
import { CYCLE_LABELS, SUBSCRIPTION_CYCLES } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';

interface SubscriptionRowProps {
  sub: SubscriptionPublic;
  onDeleteClick: (id: string, name: string) => void;
}

function SubscriptionRow({ sub, onDeleteClick }: SubscriptionRowProps) {
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
          aria-label={`${sub.name}を削除`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function SubscriptionList({ initialData }: { initialData: SubscriptionPublic[] }) {
  // useOptimisticの型引数を明示
  const [optimisticSubscriptions, mutateOptimisticSubscriptions] = useOptimistic<SubscriptionPublic[], string>(
    initialData,
    (state, idToDelete) => state.filter((sub) => sub.id !== idToDelete)
  );

  const [deleteTarget, setDeleteTarget] = useState<{ id: string, name: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const executeDelete = async () => {
    if (!deleteTarget) return;

    setIsDeleting(true);

    startTransition(() => {
      mutateOptimisticSubscriptions(deleteTarget.id);
    });

    // path引数は削除済み
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

### 5\. メインページ & ローディング (`app/`)

**`app/page.tsx`**
多通貨表示に対応。

```tsx
import { getSubscriptions } from './actions';
import { SubscriptionList } from './_components/subscription-list';
import { AddSubscriptionButton } from './_components/add-subscription-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { JapaneseYen, Globe, CreditCard, AlertCircle } from 'lucide-react';
import { calculateMonthlyAggregations, formatDisplayPrice } from '@/lib/utils';
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

  // 通貨ごとの集計を取得
  const totals = calculateMonthlyAggregations(data);

  return (
    <div className="container mx-auto py-10 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">サブスク管理</h1>
        <AddSubscriptionButton />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* JPY 月額合計 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">月額固定費 (JPY)</CardTitle>
            <JapaneseYen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDisplayPrice(totals.JPY, 'JPY')}</div>
            <p className="text-xs text-muted-foreground mt-1">
              ※年額プランは月割り計算
            </p>
          </CardContent>
        </Card>

        {/* 外貨建て合計 (USD/EUR) */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">外貨建て固定費</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <div className="flex justify-between text-sm items-center">
                <span className="text-muted-foreground">USD:</span>
                <span className="font-bold">{formatDisplayPrice(totals.USD, 'USD')}</span>
              </div>
              <div className="flex justify-between text-sm items-center">
                <span className="text-muted-foreground">EUR:</span>
                <span className="font-bold">{formatDisplayPrice(totals.EUR, 'EUR')}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 契約数 */}
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

**`app/loading.tsx` (新規追加)**
初期ロード時のUX向上（Suspense対応）。

```tsx
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader } from "@/components/ui/card"

export default function Loading() {
  return (
    <div className="container mx-auto py-10 space-y-8">
      <div className="flex justify-between items-center">
        <Skeleton className="h-9 w-48" /> {/* Title */}
        <Skeleton className="h-10 w-32" /> {/* Button */}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* KPI Cards Skeletons */}
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4 rounded-full" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-20 mb-1" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
             {/* List Rows Skeletons */}
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-8 w-8 rounded-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
```
