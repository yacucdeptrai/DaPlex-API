import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  Delete,
  UseGuards,
  ClassSerializerInterceptor,
  UseInterceptors,
  HttpCode
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
  getSchemaPath
} from '@nestjs/swagger';

import { MediaService } from './media.service';
import { MediaImagesService } from './media-images.service';
import { CreateMediaDto, UpdateMediaDto, FindMediaDto, OffsetPageMediaDto, CursorPageMediaDto } from './dto';
import { AuthUserDto } from '../users';
import { Media, MediaDetails } from './entities';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ErrorMessage } from '../auth';
import { HeadersDto } from '../../common/dto';
import { CursorPaginated, Paginated } from '../../common/entities';
import { UploadImageInterceptor } from '../../common/interceptors';
import { ParseBigIntPipe } from '../../common/pipes';
import { AuthGuardOptions } from '../../decorators/auth-guard-options.decorator';
import { AuthUser } from '../../decorators/auth-user.decorator';
import { FileUpload } from '../../decorators/file-upload.decorator';
import { RolesGuardOptions } from '../../decorators/roles-guard-options.decorator';
import { RequestHeaders } from '../../decorators/request-headers.decorator';
import { UserPermission } from '../../enums';
import {
  UPLOAD_BACKDROP_MAX_SIZE,
  UPLOAD_BACKDROP_MIN_HEIGHT,
  UPLOAD_BACKDROP_MIN_WIDTH,
  UPLOAD_BACKDROP_RATIO,
  UPLOAD_MEDIA_IMAGE_TYPES,
  UPLOAD_POSTER_MAX_SIZE,
  UPLOAD_POSTER_MIN_HEIGHT,
  UPLOAD_POSTER_MIN_WIDTH,
  UPLOAD_POSTER_RATIO
} from '../../config';

@ApiTags('Media')
@ApiExtraModels(Media)
@Controller()
export class MovieController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly mediaImagesService: MediaImagesService
  ) {}

  @Post()
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiOperation({ summary: `Create a new movie or tv show (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiOkResponse({ description: 'Return new media', type: MediaDetails })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  create(
    @AuthUser() authUser: AuthUserDto,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() createMediaDto: CreateMediaDto
  ) {
    return this.mediaService.create(createMediaDto, headers, authUser);
  }

  @Get()
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiOperation({ summary: `Find all media (optional auth, optional permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiOkResponse({
    description: 'Return a list of media',
    schema: {
      allOf: [
        { $ref: getSchemaPath(Paginated) },
        { properties: { results: { type: 'array', items: { $ref: getSchemaPath(Media) } } } }
      ]
    }
  })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  findAll(
    @AuthUser() authUser: AuthUserDto,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Query() offsetPageMediaDto: OffsetPageMediaDto
  ) {
    return this.mediaService.findAll(offsetPageMediaDto, headers, authUser);
  }

  @Get('cursor')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiOperation({
    summary: `Find all media using cursor pagination (optional auth, optional permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiOkResponse({
    description: 'Return a list of media',
    schema: {
      allOf: [
        { $ref: getSchemaPath(CursorPaginated) },
        { properties: { results: { type: 'array', items: { $ref: getSchemaPath(Media) } } } }
      ]
    }
  })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  findAllCursor(
    @AuthUser() authUser: AuthUserDto,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Query() cursorPageMediaDto: CursorPageMediaDto
  ) {
    return this.mediaService.findAllCursor(cursorPageMediaDto, headers, authUser);
  }

  @Get(':id')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: `Get details of a media (optional auth, optional permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiOkResponse({
    description: 'Return a media, users with granted permissions can see more details',
    type: MediaDetails
  })
  @ApiForbiddenResponse({ description: 'The media is private', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  findOne(
    @AuthUser() authUser: AuthUserDto,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Query() findMediaDto: FindMediaDto
  ) {
    return this.mediaService.findOne(id, headers, findMediaDto, authUser);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Update details of a media (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiOkResponse({ description: 'Return updated media', type: MediaDetails })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  update(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() updateMediaDto: UpdateMediaDto
  ) {
    return this.mediaService.update(id, updateMediaDto, headers, authUser);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Delete a media (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Media has beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  remove(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaService.remove(id, headers, authUser);
  }

  @Patch(':id/poster')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @UseInterceptors(
    new UploadImageInterceptor({
      maxSize: UPLOAD_POSTER_MAX_SIZE,
      mimeTypes: UPLOAD_MEDIA_IMAGE_TYPES,
      minWidth: UPLOAD_POSTER_MIN_WIDTH,
      minHeight: UPLOAD_POSTER_MIN_HEIGHT,
      ratio: UPLOAD_POSTER_RATIO,
      autoResize: true,
      allowUrl: true
    })
  )
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: `Upload media poster (permissions: ${UserPermission.MANAGE_MEDIA})`,
    description: `Limit: ${UPLOAD_POSTER_MAX_SIZE} Bytes<br/>Min resolution: ${UPLOAD_POSTER_MIN_WIDTH}x${UPLOAD_POSTER_MIN_HEIGHT}<br/>
    Mime types: ${UPLOAD_MEDIA_IMAGE_TYPES.join(', ')}<br/>Aspect ratio: ${UPLOAD_POSTER_RATIO.join(':')}`
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      oneOf: [
        { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
        { type: 'object', properties: { url: { type: 'string', format: 'uri' } } }
      ]
    }
  })
  @ApiOkResponse({ description: 'Return poster url' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiUnprocessableEntityResponse({ description: 'Failed to check file type', type: ErrorMessage })
  @ApiUnsupportedMediaTypeResponse({ description: 'Unsupported file', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  updatePoster(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @FileUpload() file: Storage.MultipartFile,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaImagesService.uploadMediaPoster(id, file, headers, authUser);
  }

  @Delete(':id/poster')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Delete the current poster of a media (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Poster has beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  deletePoster(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaImagesService.deleteMediaPoster(id, headers, authUser);
  }

  @Patch(':id/backdrop')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @UseInterceptors(
    new UploadImageInterceptor({
      maxSize: UPLOAD_BACKDROP_MAX_SIZE,
      mimeTypes: UPLOAD_MEDIA_IMAGE_TYPES,
      minWidth: UPLOAD_BACKDROP_MIN_WIDTH,
      minHeight: UPLOAD_BACKDROP_MIN_HEIGHT,
      ratio: UPLOAD_BACKDROP_RATIO,
      autoResize: true,
      allowUrl: true
    })
  )
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: `Upload media backdrop (permissions: ${UserPermission.MANAGE_MEDIA})`,
    description: `Limit: ${UPLOAD_BACKDROP_MAX_SIZE} Bytes<br/>Min resolution: ${UPLOAD_BACKDROP_MIN_WIDTH}x${UPLOAD_BACKDROP_MIN_HEIGHT}<br/>
    Mime types: ${UPLOAD_MEDIA_IMAGE_TYPES.join(', ')}<br/>Aspect ratio: ${UPLOAD_BACKDROP_RATIO.join(':')}`
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      oneOf: [
        { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
        { type: 'object', properties: { url: { type: 'string', format: 'uri' } } }
      ]
    }
  })
  @ApiOkResponse({ description: 'Return backdrop url' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiUnprocessableEntityResponse({ description: 'Failed to check file type', type: ErrorMessage })
  @ApiUnsupportedMediaTypeResponse({ description: 'Unsupported file', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  updateBackdrop(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @FileUpload() file: Storage.MultipartFile,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaImagesService.uploadMediaBackdrop(id, file, headers, authUser);
  }

  @Delete(':id/backdrop')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Delete the current backdrop of a media (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Backdrop has beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  deleteBackdrop(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaImagesService.deleteMediaBackdrop(id, headers, authUser);
  }
}
