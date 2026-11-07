function out = mat_dump(v)
% Exact, JSON-safe description of one MATLAB value: class, size and values
% (floats as num2hex bit patterns, integers as decimal text, char as UTF-16
% code units, column-major). Test tooling only; ETL never runs MATLAB.
out = struct('class', class(v), 'size', size(v));
if issparse(v)
    out.sparse = true;
    [i, j, x] = find(v);
    out.nnz = nnz(v); out.rows = i(:)'; out.cols = j(:)';
    if islogical(x)
        out.bits = {double(x(:))'};
    else
        out.hex = cellstr(num2hex(real(full(x(:)))))';
        if ~isreal(x), out.imag_hex = cellstr(num2hex(imag(full(x(:)))))'; end
    end
elseif isfloat(v)
    out.complex = ~isreal(v);
    out.hex = cellstr(num2hex(real(v(:))))';
    if ~isreal(v), out.imag_hex = cellstr(num2hex(imag(v(:))))'; end
elseif isinteger(v)
    out.dec = cellstr(string(v(:)))';
elseif islogical(v)
    out.bits = {double(v(:))'};
elseif ischar(v)
    out.units = {double(v(:))'};
elseif iscell(v)
    out.items = cellfun(@mat_dump, v(:)', 'UniformOutput', false);
elseif isstruct(v)
    out.fields = fieldnames(v)';
    if isscalar(v)
        for k = 1:numel(out.fields)
            out.values.(out.fields{k}) = mat_dump(v.(out.fields{k}));
        end
    end
elseif isstring(v)
    out.strings = cellstr(v(:))';
    out.missing = {double(ismissing(v(:)))'};
end
end
