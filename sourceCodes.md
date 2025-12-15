
### ディレクトリ構造

```text
app/
 ├── actions.ts           # Server Actions (DB操作ロジック)
 ├── page.tsx             # メイン画面 (Server Component / データ取得)
 └── _components/         # 画面固有のUIパーツ
      ├── add-button.tsx  # 追加モーダル (Client Component)
      ├── sub-list.tsx    # 一覧表示テーブル
      └── del-button.tsx  # 削除アラート (Client Component)
db/
 ├── schema.ts            # Drizzleスキーマ定義
 └── index.ts             # DB接続設定
lib/
 └── schema.ts            # Zodバリデーション定義 (共通)
```

-----

### 事前準備 (Environment & Dependencies)

`.env` ファイルにデータベース接続文字列が必要です。

```env
DATABASE_URL="postgresql://user:password@host:port/dbname"
```

### 1\. ユーティリティ & 設定

**`lib/utils.ts`** (Shadcn UIの標準ユーティリティ)

```typescript
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

**`db/schema.ts`** (データベース定義)

```typescript
import { pgTable, text, integer, boolean, timestamp, uuid, date } from 'drizzle-orm/pg-core';

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(), // 今回はデモ用IDを使用
  
  name: text('name').notNull(),
  price: integer('price').notNull(),
  currency: text('currency').default('JPY').notNull(),
  cycle: text('cycle', { enum: ['monthly', 'yearly'] }).notNull(),
  nextPayment: date('next_payment').notNull(),
  
  category: text('category').default('general'),
  isActive: boolean('is_active').default(true).notNull(),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

**`db/index.ts`** (データベース接続)

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// 環境変数が読み込まれていることを確認してください
const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);

export const db = drizzle(client, { schema });
```

**`lib/schema.ts`** (バリデーション定義)

```typescript
import { z } from 'zod';

export const formSchema = z.object({
  name: z.string().min(1, 'サービス名は必須です'),
  price: z.coerce.number().min(1, '金額を入力してください'),
  cycle: z.enum(['monthly', 'yearly'], {
    required_error: '支払いサイクルを選択してください',
  }),
  nextPayment: z.string().date(), // YYYY-MM-DD形式
  category: z.string().optional(),
});

export type FormValues = z.infer<typeof formSchema>;
```

-----

### 2\. バックエンドロジック (Server Actions)

**`app/actions.ts`**

```typescript
'use server';

import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { formSchema, FormValues } from '@/lib/schema';
import { eq, desc } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

// デモ用の固定ユーザーID。認証導入後は session.user.id に置き換えます。
const DEMO_USER_ID = 'user_demo_123'; 

// 一覧取得
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

// 追加
export async function addSubscription(data: FormValues) {
  // 1. バリデーション
  const validated = formSchema.safeParse(data);
  if (!validated.success) {
    return { success: false, error: '入力内容に誤りがあります' };
  }

  try {
    // 2. 保存
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

// 削除
export async function deleteSubscription(id: string) {
  try {
    await db.delete(subscriptions)
      .where(eq(subscriptions.id, id)); 
      // 本番環境では AND eq(subscriptions.userId, currentUserId) も追加してください
    
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

**`app/_components/delete-button.tsx`** (削除ボタン)

```tsx
'use client';

import { useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { deleteSubscription } from '@/app/actions';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

interface DeleteButtonProps {
  id: string;
  name: string;
}

export function DeleteButton({ id, name }: DeleteButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const handleDelete = () => {
    startTransition(async () => {
      const result = await deleteSubscription(id);
      if (result.success) {
        setOpen(false);
      } else {
        alert('削除に失敗しました');
      }
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive">
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>本当に削除しますか？</AlertDialogTitle>
          <AlertDialogDescription>
            「{name}」のデータを完全に削除します。<br />
            この操作は取り消せません。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>キャンセル</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleDelete();
            }}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? '削除中...' : '削除する'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

**`app/_components/add-subscription-button.tsx`** (追加ボタン & モーダル)

```tsx
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { formSchema, FormValues } from '@/lib/schema';
import { addSubscription } from '@/app/actions';

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
      cycle: 'monthly',
      nextPayment: new Date().toISOString().split('T')[0],
    },
  });

  async function onSubmit(values: FormValues) {
    const res = await addSubscription(values);
    if (res.success) {
      setOpen(false);
      form.reset();
    } else {
      alert('エラーが発生しました');
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
                          <SelectItem value="monthly">月額</SelectItem>
                          <SelectItem value="yearly">年額</SelectItem>
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

**`app/_components/subscription-list.tsx`** (一覧リスト)

```tsx
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { DeleteButton } from './delete-button';

// 本来はDrizzleのInferSelectModelを使うのがベストですが、簡易定義
type Subscription = {
  id: string;
  name: string;
  price: number;
  cycle: 'monthly' | 'yearly' | string;
  nextPayment: string;
  category: string | null;
  isActive: boolean;
};

export function SubscriptionList({ initialData }: { initialData: Subscription[] }) {
  if (initialData.length === 0) {
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
        {initialData.map((sub) => (
          <TableRow key={sub.id}>
            <TableCell className="font-medium">{sub.name}</TableCell>
            <TableCell>¥{sub.price.toLocaleString()}</TableCell>
            <TableCell>
              <Badge variant={sub.cycle === 'monthly' ? 'secondary' : 'outline'}>
                {sub.cycle === 'monthly' ? '月額' : '年額'}
              </Badge>
            </TableCell>
            <TableCell>{sub.nextPayment}</TableCell>
            <TableCell className="text-right">
              <DeleteButton id={sub.id} name={sub.name} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

-----

### 4\. メインページ

**`app/page.tsx`**

```tsx
import { getSubscriptions } from './actions';
import { SubscriptionList } from './_components/subscription-list';
import { AddSubscriptionButton } from './_components/add-subscription-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { JapaneseYen, CreditCard } from 'lucide-react';

export default async function DashboardPage() {
  const data = await getSubscriptions();

  // 簡易計算: 月額のものだけを合計
  const totalMonthly = data
    .filter((sub) => sub.cycle === 'monthly')
    .reduce((acc, curr) => acc + curr.price, 0);

  return (
    <div className="container mx-auto py-10 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">サブスク管理</h1>
        <AddSubscriptionButton />
      </div>

      {/* KPI エリア */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">月額固定費</CardTitle>
            <JapaneseYen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">¥{totalMonthly.toLocaleString()}</div>
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

      {/* リスト表示エリア */}
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
