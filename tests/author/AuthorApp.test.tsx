import { fireEvent, render, screen } from '@testing-library/react';
import { AuthorApp } from '@/author/AuthorApp';

describe('AuthorApp', () => {
  it('opens Models and switches among the four named sections', async () => {
    render(<AuthorApp />);
    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '3D Model Editor' }));
    expect(screen.getByRole('heading', { name: '3D Model Editor' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Story Editor' }));
    expect(screen.getByRole('heading', { name: 'Story Editor' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'World Editor' }));
    expect(await screen.findByRole('heading', { name: 'World Editor' }, { timeout: 5_000 })).toBeInTheDocument();
  });
});
