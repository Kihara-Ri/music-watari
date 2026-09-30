// 笔记框随内容自动长高：打开时撑开一次，输入时实时长高，长文完全可读。
import {useLayoutEffect, useRef} from 'react';
import type {TextareaHTMLAttributes} from 'react';

export function AutoTextarea({value, ...rest}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const t = ref.current;
    if (t) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }
  });
  return <textarea ref={ref} value={value} {...rest}/>;
}
