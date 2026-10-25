import { useI18n } from '@/i18n/context';
import { ArrowUpDown, ArrowUpAZ, ArrowDownAZ, TrendingUp, TrendingDown, Check } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type SortOption = 'name-asc' | 'name-desc' | 'progress-asc' | 'progress-desc';

interface SortDropdownProps {
  value: SortOption;
  onChange: (value: SortOption) => void;
}



export function SortDropdown({ value, onChange }: SortDropdownProps) {
  const { t } = useI18n();
  const SORT_OPTIONS: { value: SortOption; label: string; icon: React.ReactNode }[] = [
  { value: 'name-asc', label: t('sort.nameAsc'), icon: <ArrowUpAZ className="h-4 w-4" /> },
  { value: 'name-desc', label: t('sort.nameDesc'), icon: <ArrowDownAZ className="h-4 w-4" /> },
  { value: 'progress-asc', label: t('sort.progressAsc'), icon: <TrendingDown className="h-4 w-4" /> },
  { value: 'progress-desc', label: t('sort.progressDesc'), icon: <TrendingUp className="h-4 w-4" /> },
];

  const selectedOption = SORT_OPTIONS.find(opt => opt.value === value);
  
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn(
        "w-[170px] h-9 gap-2",
        "bg-background/50 border-border/50",
        "hover:border-border transition-colors"
      )}>
        <ArrowUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        <SelectValue placeholder={t('sort.by')}>
          {selectedOption?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {SORT_OPTIONS.map(option => (
          <SelectItem key={option.value} value={option.value}>
            <div className="flex items-center justify-between w-full gap-3">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-muted-foreground",
                  value === option.value && "text-primary"
                )}>
                  {option.icon}
                </span>
                <span>{option.label}</span>
              </div>
              {value === option.value && (
                <Check className="h-4 w-4 shrink-0 text-primary" />
              )}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
