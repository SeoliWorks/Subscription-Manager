
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

### 1\. ユーティリティ & 定数 (`lib/`)

**`lib/constants.ts`**
通貨設定（小数点の扱い）とサイクル定義を集約しています。

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
金額の変換ロジック（UI用 ⇔ DB用）とフォーマッターを含みます。

```typescript
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { type Subscription } from "@/db/schema"
import { SUBSCRIPTION_CYCLES, CURRENCIES, type CurrencyCode } from "./constants"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// クライアント/サーバー共通で使える「今日」の日付文字列 (YYYY-MM-DD)
export function getLocalTodayString(): string {
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
 * 通貨を見やすくフォーマットする
 * DBの整数値を受け取り、自動的に小数に戻してフォーマットします
 */
export function formatCurrency(amountFromDb: number, currency: string): string {
  const actualAmount = convertAmountFromMinorUnits(amountFromDb, currency);
  
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: currency,
  }).format(actualAmount);
}

/**
 * 指定通貨での月額換算合計を計算
 */
export function calculateMonthlyTotal(
  subscriptions: Subscription[], 
  targetCurrency: CurrencyCode = 'JPY'
): number {
  return subscriptions
    .filter(sub => sub.currency === targetCurrency)
    .reduce((acc, curr) => {
      // 一度「実際の金額」に戻す
      const actualPrice = convertAmountFromMinorUnits(curr.price, curr.currency);
      
      let monthlyPrice = actualPrice;
      if (curr.cycle === SUBSCRIPTION_CYCLES.yearly) {
        // 年額は12で割る
        monthlyPrice = actualPrice / 12;
      }
      
      return acc + monthlyPrice;
    }, 0);
}
```

**`lib/validations.ts`**
厳格化されたZodスキーマ定義です。

```typescript
import { z } from 'zod';
import { SUBSCRIPTION_CYCLES, CURRENCIES } from '@/lib/constants';

export const formSchema = z.object({
  name: z.string().min(1, 'サービス名は必須です'),
  // UI上は小数を許容する
  price: z.coerce.number()
    .min(0.01, '金額を入力してください')
    .nonnegative('マイナスの金額は入力できません'),
  currency: z.enum([CURRENCIES.JPY.code, CURRENCIES.USD.code, CURRENCIES.EUR.code]),
  cycle: z.enum([SUBSCRIPTION_CYCLES.monthly, SUBSCRIPTION_CYCLES.yearly], {
    required_error: '支払いサイクルを選択してください',
  }),
  nextPayment: z.string().date().refine((val) => {
    const date = new Date(val);
    // 日付として無効、または極端な過去などを弾く
    return !isNaN(date.getTime()) && date.getFullYear() > 2000;
  }, '正しい日付を入力してください'),
  category: z.string().optional(),
});

export type FormValues = z.infer<typeof formSchema>;
```

-----

### 2\. データベース設定 (`db/`)

**`db/index.ts`**
環境変数チェックを追加したDB接続設定です。

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Fail Fast: 設定ミスを即座に検知
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

const connectionString = process.env.DATABASE_URL;

const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

// 開発環境と本番環境でコネクション管理を切り分け
const client = globalForDb.conn ?? postgres(connectionString, { 
  max: process.env.NODE_ENV === 'production' ? 10 : 1, 
});

if (process.env.NODE_ENV !== 'production') {
  globalForDb.conn = client;
}

export const db = drizzle(client, { schema });
```

**`db/schema.ts`**
インデックスを追加し、金額を整数型で定義しています。

```typescript
import { pgTable, text, integer, boolean, timestamp, uuid, date, index } from 'drizzle-orm/pg-core';
import { type InferSelectModel, type InferInsertModel } from 'drizzle-orm';
import { SUBSCRIPTION_CYCLES, CURRENCIES } from '@/lib/constants';

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(), // Auth ID
  
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
    // ユーザーIDでの検索を高速化
    userIdIdx: index('user_id_idx').on(table.userId),
  };
});

export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;
```

-----

### 3\. Server Actions (`app/actions.ts`)

DB保存時の通貨変換処理を組み込んでいます。

```typescript
'use server';

import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { formSchema, type FormValues } from '@/lib/validations';
import { convertAmountToMinorUnits } from '@/lib/utils';
import { eq, desc, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

// --- Auth Mock ---
async function getCurrentUser() {
  return { id: 'user_demo_123' };
}
// -----------------

export type ActionResponse<T = null> = {
  success: boolean;
  data?: T;
  error?: string;
};

// フロントエンド公開用データ型
type SubscriptionPublic = Omit<typeof subscriptions.$inferSelect, 'userId' | 'createdAt'>;

export async function getSubscriptions(): Promise<ActionResponse<SubscriptionPublic[]>> {
  try {
    const user = await getCurrentUser();
    
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
    return { success: true, data };
  } catch (error) {
    console.error('Failed to fetch subscriptions:', error);
    return { success: false, error: 'データの取得に失敗しました', data: [] };
  }
}

// path引数を追加して、どこから呼ばれても画面更新できるように変更
export async function addSubscription(data: FormValues, path: string = '/'): Promise<ActionResponse> {
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

    revalidatePath(path);
    return { success: true };
  } catch (error) {
    console.error('Failed to add subscription:', error);
    return { success: false, error: 'データベースへの保存に失敗しました' };
  }
}

export async function deleteSubscription(id: string, path: string = '/'): Promise<ActionResponse> {
  try {
    const user = await getCurrentUser();

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
    
    revalidatePath(path);
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
通貨選択機能を追加したモーダルフォームです。

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
import { usePathname } from 'next/navigation';

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
  const pathname = usePathname();
  
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      price: 0,
      currency: CURRENCIES.JPY.code,
      cycle: SUBSCRIPTION_CYCLES.monthly,
      nextPayment: getLocalTodayString(),
      category: 'general',
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: FormValues) {
    const res = await addSubscription(values, pathname);
    
    if (res.success) {
      toast.success('サブスクリプションを追加しました');
      setOpen(false);
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
`formatCurrency` を使用して、DBの値（整数）を正しい通貨表記で表示します。

```tsx
'use client';

import { useOptimistic, startTransition, useState } from 'react';
import { usePathname } from 'next/navigation';
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
import { formatCurrency } from '@/lib/utils';
import { deleteSubscription } from '@/app/actions';

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
          aria-label={`${sub.name}を削除`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function SubscriptionList({ initialData }: { initialData: any[] }) {
  const pathname = usePathname();
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

    const result = await deleteSubscription(deleteTarget.id, pathname);

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

### 5\. メインページ (`app/page.tsx`)

`calculateMonthlyTotal` を呼び出し、UI表示では `formatCurrency` を使うように変更済みです。

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

  // JPYのみを計算し、表示用合計金額を取得
  // (utils側でDB値を実数に戻して計算しています)
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
            {/* 合計値をJPY形式でフォーマット */}
            <div className="text-2xl font-bold">{formatCurrency(totalMonthly, 'JPY')}</div>
            <p className="text-xs text-muted-foreground mt-1">
              ※年額プランは月割り計算 / 外貨建ては現在集計対象外
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
