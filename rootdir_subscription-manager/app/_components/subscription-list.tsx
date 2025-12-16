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
