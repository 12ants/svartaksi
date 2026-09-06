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
    // The World Editor is lazy-loaded; the wait for it is the global asyncUtilTimeout.
    expect(await screen.findByRole('heading', { name: 'World Editor' })).toBeInTheDocument();
  });
});
