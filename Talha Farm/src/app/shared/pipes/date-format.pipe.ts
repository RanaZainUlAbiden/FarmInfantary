import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'dateOnly',
  standalone: true
})
export class DateOnlyPipe implements PipeTransform {
  transform(value: string | Date | null): string {
    if (!value) return '—';

    // Normalise to a YYYY-MM-DD date part (drop any time / timezone portion)
    let datePart: string;
    if (value instanceof Date) {
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, '0');
      const d = String(value.getDate()).padStart(2, '0');
      datePart = `${y}-${m}-${d}`;
    } else {
      datePart = String(value).split('T')[0].split(' ')[0];
    }

    // Reformat YYYY-MM-DD -> DD-MM-YYYY
    const parts = datePart.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }

    return datePart;
  }
}
