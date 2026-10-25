'use client';

import type { WorkflowSummary } from '@aap/shared';
import { LoaderCircle, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useStartExecution } from '@/hooks/use-api';
import { ApiError } from '@/lib/api-client';
import {
  buildFormModel,
  clientValidator,
  toWorkflowInput,
  type FieldSpec,
  type FormValues,
} from './schema-fields';

function hint(field: FieldSpec): string | null {
  switch (field.kind) {
    case 'string-list':
      return 'One item per line.';
    case 'number':
      if (field.min !== null && field.max !== null) return `From ${field.min} to ${field.max}.`;
      return null;
    case 'json':
      return 'JSON value.';
    default:
      return null;
  }
}

export function StartWorkflowForm({ workflow }: { workflow: WorkflowSummary }) {
  const router = useRouter();
  const start = useStartExecution();
  const model = useMemo(
    () => buildFormModel(workflow.inputSchema) ?? { fields: [], defaults: {} },
    [workflow.inputSchema],
  );
  const validator = useMemo(() => clientValidator(workflow.inputSchema), [workflow.inputSchema]);

  // Converts the form strings, then validates them with the workflow's own schema.
  const resolver = useMemo<Resolver<FormValues>>(
    () => (values) => {
      const converted = toWorkflowInput(model.fields, values);
      if (!converted.success) {
        return {
          values: {},
          errors: Object.fromEntries(
            Object.entries(converted.errors).map(([name, message]) => [
              name,
              { type: 'validate', message },
            ]),
          ),
        };
      }
      const checked = validator?.safeParse(converted.input);
      if (checked !== undefined && !checked.success) {
        const errors: Record<string, { type: string; message: string }> = {};
        for (const issue of checked.error.issues) {
          const name = String(issue.path[0] ?? 'root');
          errors[name] ??= { type: 'validate', message: issue.message };
        }
        return { values: {}, errors };
      }
      return { values: converted.input as FormValues, errors: {} };
    },
    [model.fields, validator],
  );

  const form = useForm<FormValues>({ defaultValues: model.defaults, resolver });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (input) => {
    try {
      const { execution } = await start.mutateAsync({ workflowId: workflow.id, input });
      router.push(`/executions/detail?id=${execution.id}`);
    } catch (error) {
      // Server-side validation is authoritative: show its issues on the matching fields.
      if (error instanceof ApiError && error.issues.length > 0) {
        for (const issue of error.issues) {
          const name = issue.path.split('.')[0] ?? 'root';
          form.setError(name === '' ? 'root' : name, { message: issue.message });
        }
        return;
      }
      form.setError('root', {
        message: error instanceof Error ? error.message : 'Could not start the workflow.',
      });
    }
  });

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="flex max-w-xl flex-col gap-5"
      noValidate
    >
      {model.fields.map((field) => {
        const id = `field-${field.name}`;
        const error = errors[field.name]?.message;
        const help = field.description ?? hint(field);
        return (
          <div key={field.name} className="flex flex-col gap-2">
            {field.kind === 'boolean' ? (
              <Controller
                control={form.control}
                name={field.name}
                render={({ field: control }) => (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={control.value === true}
                      onCheckedChange={(checked) => control.onChange(checked)}
                    />
                    <Label htmlFor={id}>{field.label}</Label>
                  </div>
                )}
              />
            ) : (
              <>
                <Label htmlFor={id}>
                  {field.label}
                  {field.required ? <span className="text-destructive"> *</span> : null}
                </Label>
                {field.kind === 'enum' ? (
                  <Controller
                    control={form.control}
                    name={field.name}
                    render={({ field: control }) => (
                      <Select
                        items={field.options.map((option) => ({ value: option, label: option }))}
                        value={typeof control.value === 'string' ? control.value : ''}
                        onValueChange={(value) => control.onChange(value ?? '')}
                      >
                        <SelectTrigger id={id} className="w-full">
                          <SelectValue placeholder="Choose…" />
                        </SelectTrigger>
                        <SelectContent>
                          {field.options.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                ) : field.kind === 'string-list' || field.kind === 'json' ? (
                  <Textarea
                    id={id}
                    rows={field.kind === 'json' ? 6 : 5}
                    className={field.kind === 'json' ? 'font-mono text-xs' : undefined}
                    aria-invalid={error !== undefined}
                    {...form.register(field.name)}
                  />
                ) : (
                  <Input
                    id={id}
                    type={field.kind === 'number' ? 'number' : 'text'}
                    inputMode={field.kind === 'number' ? 'numeric' : undefined}
                    aria-invalid={error !== undefined}
                    {...form.register(field.name)}
                  />
                )}
              </>
            )}
            {help === null ? null : <p className="text-xs text-muted-foreground">{help}</p>}
            {error === undefined ? null : (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}

      {errors.root?.message === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      )}

      <div>
        <Button type="submit" disabled={isSubmitting || !workflow.availability.available}>
          {isSubmitting ? (
            <LoaderCircle className="animate-spin" aria-hidden />
          ) : (
            <Play aria-hidden />
          )}
          Start execution
        </Button>
      </div>
    </form>
  );
}
