// 表单字段构造：受控 input / 自动长高 textarea / 币种金额组（买入金额同款）。
import type {InputHTMLAttributes} from 'react';
import {AutoTextarea} from '../components/ui/AutoTextarea';
import {Seg} from '../components/ui/Seg';
import type {Currency} from '../types';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {label: string; name: string};

export function Field({label, name, ...rest}: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{label}</label>
      <input id={`f-${name}`} name={name} {...rest}/>
    </div>
  );
}

// 币种分段 + 金额输入（与专辑「买入金额」同一组件）：切到日元时金额取整。
export function MoneyField({label, name, currency, value, onCurrency, onChange}: {
  label: string; name: string; currency: Currency; value: string;
  onCurrency: (c: Currency, value: string) => void; onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{label}</label>
      <div className="amount-group">
        <Seg className="seg-cur" ariaLabel="币种"
             options={[{value: 'JPY', label: '日元'}, {value: 'CNY', label: '人民币'}]}
             value={currency}
             onValue={c => onCurrency(c as Currency,
               c === 'JPY' && value !== '' ? String(Math.round(Number(value))) : value)}/>
        {/* 日元不设步进限制：step=10 会把 1145 円这类非整十金额判为无效，表单提交被浏览器静默拦截；
           整数口径由输入过滤保证（numeric 键盘无小数点，硬件键入也滤掉 .） */}
        <input id={`f-${name}`} name={name} type="number" required min="0"
               step={currency === 'JPY' ? 'any' : '0.01'}
               inputMode={currency === 'JPY' ? 'numeric' : 'decimal'}
               placeholder="按币种填写" value={value}
               onChange={e => onChange(currency === 'JPY' ? e.target.value.replace(/[^\d]/g, '') : e.target.value)}/>
      </div>
    </div>
  );
}

export function TextareaField({label, name, value, onChange, className = ''}: {
  label: string; name: string; value: string;
  onChange: (v: string) => void; className?: string;
}) {
  return (
    <div className={`field full ${className}`.trim()}>
      <label htmlFor={`f-${name}`}>{label}</label>
      <AutoTextarea id={`f-${name}`} name={name} value={value}
                    onChange={e => onChange(e.target.value)}/>
    </div>
  );
}
