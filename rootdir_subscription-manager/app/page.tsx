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
